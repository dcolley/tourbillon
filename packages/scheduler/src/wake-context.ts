/**
 * WC2: live wake context, read from the DB at run start (not at enqueue: wakes can sit in the
 * queue). Deterministic, no model calls: a handful of company-scoped selects. The result is plain
 * JSON handed to the pure renderer in @tourbillon/shared (buildWakeMessageWithStats).
 */
import { createHash } from 'crypto';
import { and, arrayContains, desc, eq, gt, inArray, like, lt, or } from 'drizzle-orm';
import type { activityLog, agents, approvals, db, issues } from '@tourbillon/db';
import {
  WAKE_CONTEXT_VERSION,
  buildWakeMessageWithStats,
  parseCompanySettings,
  resolveWakeContextConfig,
  type HeartbeatJobData,
  type WakePayload,
  WAKE_HEADER_MAX_BLOCKERS,
  extractApprovalTokens,
  extractIssueIdentifiers,
  type WakeApprovalRef,
  type WakeIssueRef,
  type WakeLiveContext,
  type WakeReason,
} from '@tourbillon/shared';

export interface WakeIssueRow {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  parentId: string | null;
  blockedByIssueIds: string[] | null;
}

export interface WakeApprovalRow {
  id: string;
  companyId: string;
  status: string;
  note: string | null;
  decidedAt: Date | string | null;
  createdAt: Date | string;
  issueIds: string[] | null;
  payload: unknown;
}

/** Every read buildWakeContext needs. Each call must be scoped to `companyId`. */
export interface WakeContextRepo {
  getIssue(companyId: string, issueId: string): Promise<WakeIssueRow | null>;
  getIssuesByIds(companyId: string, ids: string[]): Promise<WakeIssueRow[]>;
  getIssuesByIdentifiers(companyId: string, identifiers: string[]): Promise<WakeIssueRow[]>;
  getAgentName(companyId: string, agentId: string): Promise<string | null>;
  /** approvals.issue_ids @> {issueId} */
  getLinkedApprovals(companyId: string, issueId: string): Promise<WakeApprovalRow[]>;
  /** approvals whose id starts with one of the 8-hex prefixes. */
  getApprovalsByIdPrefixes(companyId: string, prefixes: string[]): Promise<WakeApprovalRow[]>;
  /** Latest activity_log row by this agent on this issue strictly before `before`. */
  getAgentLastActivityAt(companyId: string, agentId: string, issueId: string, before: Date): Promise<Date | null>;
  /** User/Board comments on this issue after `since` (all when null) and before `before`. */
  countUserCommentsSince(companyId: string, issueId: string, since: Date | null, before: Date): Promise<number>;
}

export interface BuildWakeContextInput {
  companyId: string;
  agentId: string;
  agentName: string;
  agentUrlKey?: string | null;
  taskId: string;
  wakeReason: WakeReason | string;
  runStartedAt: Date;
  /** Bodies of the payload comments: cited approval ids / issue identifiers are resolved from these. */
  commentBodies: string[];
}

const MAX_APPROVAL_PREFIXES = 50;
const MAX_IDENTIFIERS = 30;
const HEX8 = /^[0-9a-f]{8}$/;

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function payloadTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const t = (payload as Record<string, unknown>).title;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

function toApprovalRef(row: WakeApprovalRow, linked: boolean): WakeApprovalRef {
  return {
    id: row.id,
    status: row.status,
    decidedAt: iso(row.decidedAt),
    createdAt: iso(row.createdAt) ?? '',
    note: row.note ?? null,
    title: payloadTitle(row.payload),
    linked,
  };
}

/**
 * Assemble the live state for a task-bearing wake. Returns null when there is nothing to build
 * (no task, agent_mail, or the task is not in this company). Throws on repo errors: the caller
 * logs `wake_context_failed` and falls back to the T1-only message.
 */
export async function buildWakeContext(
  repo: WakeContextRepo,
  input: BuildWakeContextInput,
): Promise<WakeLiveContext | null> {
  if (!input.taskId || input.wakeReason === 'agent_mail') return null;
  const { companyId } = input;
  const task = await repo.getIssue(companyId, input.taskId);
  if (!task || task.companyId !== companyId) return null;

  const blockerIds = (task.blockedByIssueIds ?? []).filter(Boolean);
  const relatedIds = [...new Set([...(task.parentId ? [task.parentId] : []), ...blockerIds])];

  const tokens = new Set<string>();
  const identifiers = new Set<string>();
  for (const body of input.commentBodies) {
    for (const t of extractApprovalTokens(body)) if (HEX8.test(t)) tokens.add(t);
    for (const id of extractIssueIdentifiers(body)) if (id !== task.identifier) identifiers.add(id);
  }
  const prefixes = [...tokens].sort().slice(0, MAX_APPROVAL_PREFIXES);
  const idents = [...identifiers].sort().slice(0, MAX_IDENTIFIERS);
  const before = input.runStartedAt;

  const [related, linkedRows, prefixRows, referencedRows, assigneeName, lastActivity] = await Promise.all([
    relatedIds.length ? repo.getIssuesByIds(companyId, relatedIds) : Promise.resolve([]),
    repo.getLinkedApprovals(companyId, task.id),
    prefixes.length ? repo.getApprovalsByIdPrefixes(companyId, prefixes) : Promise.resolve([]),
    idents.length ? repo.getIssuesByIdentifiers(companyId, idents) : Promise.resolve([]),
    task.assigneeAgentId && task.assigneeAgentId !== input.agentId
      ? repo.getAgentName(companyId, task.assigneeAgentId)
      : Promise.resolve(null),
    repo.getAgentLastActivityAt(companyId, input.agentId, task.id, before),
  ]);
  const userComments = await repo.countUserCommentsSince(companyId, task.id, lastActivity, before);

  // Same company only (defence in depth on top of the scoped queries).
  const sameCompany = <T extends { companyId: string }>(rows: T[]) => rows.filter((r) => r.companyId === companyId);

  const approvalsById = new Map<string, WakeApprovalRef>();
  for (const row of sameCompany(linkedRows)) approvalsById.set(row.id, toApprovalRef(row, true));
  // A cited prefix resolves only when exactly one approval in the company has it.
  const byPrefix = new Map<string, WakeApprovalRow[]>();
  for (const row of sameCompany(prefixRows)) {
    const p = row.id.slice(0, 8);
    if (!tokens.has(p)) continue;
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), row]);
  }
  for (const rows of byPrefix.values()) {
    if (rows.length !== 1) continue;
    const row = rows[0];
    if (!approvalsById.has(row.id)) approvalsById.set(row.id, toApprovalRef(row, false));
  }

  const relatedById = new Map(sameCompany(related).map((r) => [r.id, r]));
  const parentRow = task.parentId ? relatedById.get(task.parentId) : undefined;
  const ref = (r: WakeIssueRow): WakeIssueRef => ({ identifier: r.identifier, status: r.status });

  const assignee: WakeLiveContext['task']['assignee'] =
    task.assigneeAgentId === input.agentId
      ? { kind: 'self', name: input.agentName }
      : task.assigneeAgentId
        ? { kind: 'agent', name: assigneeName }
        : task.assigneeUserId
          ? { kind: 'user', name: null }
          : { kind: 'none' };

  return {
    version: WAKE_CONTEXT_VERSION,
    asOf: input.runStartedAt.toISOString(),
    agent: { id: input.agentId, name: input.agentName, urlKey: input.agentUrlKey ?? null },
    task: {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assignee,
    },
    parent: parentRow ? ref(parentRow) : null,
    blockers: blockerIds
      .map((id) => relatedById.get(id))
      .filter((r): r is WakeIssueRow => Boolean(r))
      .slice(0, WAKE_HEADER_MAX_BLOCKERS + 1)
      .map(ref),
    approvals: [...approvalsById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    referencedIssues: sameCompany(referencedRows)
      .filter((r) => identifiers.has(r.identifier))
      .map(ref)
      .sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)),
    lastActivityAt: iso(lastActivity),
    userCommentsSinceLastActivity: userComments,
  };
}

export interface WakeContextTables {
  db: typeof db;
  issues: typeof issues;
  approvals: typeof approvals;
  activityLog: typeof activityLog;
  agents: typeof agents;
}

/** Drizzle-backed repo. Every query is filtered by company_id. */
export function createDrizzleWakeContextRepo(t: WakeContextTables): WakeContextRepo {
  const issueCols = {
    id: t.issues.id,
    companyId: t.issues.companyId,
    identifier: t.issues.identifier,
    title: t.issues.title,
    status: t.issues.status,
    priority: t.issues.priority,
    assigneeAgentId: t.issues.assigneeAgentId,
    assigneeUserId: t.issues.assigneeUserId,
    parentId: t.issues.parentId,
    blockedByIssueIds: t.issues.blockedByIssueIds,
  };
  const approvalCols = {
    id: t.approvals.id,
    companyId: t.approvals.companyId,
    status: t.approvals.status,
    note: t.approvals.note,
    decidedAt: t.approvals.decidedAt,
    createdAt: t.approvals.createdAt,
    issueIds: t.approvals.issueIds,
    payload: t.approvals.payload,
  };
  const issueActivity = (companyId: string, issueId: string) => [
    eq(t.activityLog.companyId, companyId),
    eq(t.activityLog.entityType, 'issue'),
    eq(t.activityLog.entityId, issueId),
  ];
  return {
    async getIssue(companyId, issueId) {
      const [row] = await t.db
        .select(issueCols)
        .from(t.issues)
        .where(and(eq(t.issues.id, issueId), eq(t.issues.companyId, companyId)))
        .limit(1);
      return row ?? null;
    },
    async getIssuesByIds(companyId, ids) {
      if (ids.length === 0) return [];
      return t.db
        .select(issueCols)
        .from(t.issues)
        .where(and(eq(t.issues.companyId, companyId), inArray(t.issues.id, ids)));
    },
    async getIssuesByIdentifiers(companyId, identifiers) {
      if (identifiers.length === 0) return [];
      return t.db
        .select(issueCols)
        .from(t.issues)
        .where(and(eq(t.issues.companyId, companyId), inArray(t.issues.identifier, identifiers)));
    },
    async getAgentName(companyId, agentId) {
      const [row] = await t.db
        .select({ name: t.agents.name })
        .from(t.agents)
        .where(and(eq(t.agents.id, agentId), eq(t.agents.companyId, companyId)))
        .limit(1);
      return row?.name ?? null;
    },
    async getLinkedApprovals(companyId, issueId) {
      return t.db
        .select(approvalCols)
        .from(t.approvals)
        .where(and(eq(t.approvals.companyId, companyId), arrayContains(t.approvals.issueIds, [issueId])))
        .limit(50);
    },
    async getApprovalsByIdPrefixes(companyId, prefixes) {
      const safe = prefixes.filter((p) => HEX8.test(p));
      if (safe.length === 0) return [];
      return t.db
        .select(approvalCols)
        .from(t.approvals)
        .where(and(eq(t.approvals.companyId, companyId), or(...safe.map((p) => like(t.approvals.id, `${p}%`)))))
        .limit(200);
    },
    async getAgentLastActivityAt(companyId, agentId, issueId, before) {
      const [row] = await t.db
        .select({ createdAt: t.activityLog.createdAt })
        .from(t.activityLog)
        .where(
          and(
            ...issueActivity(companyId, issueId),
            eq(t.activityLog.actorType, 'agent'),
            eq(t.activityLog.actorId, agentId),
            lt(t.activityLog.createdAt, before),
          ),
        )
        .orderBy(desc(t.activityLog.createdAt))
        .limit(1);
      return row?.createdAt ?? null;
    },
    async countUserCommentsSince(companyId, issueId, since, before) {
      const rows = await t.db
        .select({ details: t.activityLog.details })
        .from(t.activityLog)
        .where(
          and(
            ...issueActivity(companyId, issueId),
            eq(t.activityLog.actorType, 'user'),
            lt(t.activityLog.createdAt, before),
            ...(since ? [gt(t.activityLog.createdAt, since)] : []),
          ),
        )
        .limit(500);
      return rows.filter((r) => {
        const d = (r.details ?? {}) as Record<string, unknown>;
        return (
          (typeof d.comment === 'string' && d.comment.trim() !== '') ||
          (typeof d.body === 'string' && d.body.trim() !== '')
        );
      }).length;
    },
  };
}

/** Persisted as contextSnapshot.wakeContext (WC6). */
export interface WakeContextSnapshot extends Record<string, unknown> {
  enabled: boolean;
  source: 'company' | 'env' | 'default';
  messageSha256: string;
  error?: string;
}

/**
 * Build the wake message for a run (WC1–6). The DB read happens only when the live context is on
 * (company setting `wakeContextV2`, else env TOURBILLON_WAKE_CONTEXT_V2) and the wake carries a
 * task. Never throws: a failed context read falls back to the T1-only message.
 */
export async function buildRunWakeMessage(
  wake: HeartbeatJobData,
  opts: {
    agentId: string;
    companyId: string;
    agentName: string;
    agentUrlKey?: string | null;
    companySettings: unknown;
    runStartedAt: Date;
    tracer?: { warn: (msg: string, data?: Record<string, unknown>) => void };
    /** Repo, or a factory called only when the live context is on. */
    repo: WakeContextRepo | (() => WakeContextRepo);
    buildContext?: typeof buildWakeContext;
  },
): Promise<{ wakeMessage: string; wakeContextSnapshot: WakeContextSnapshot }> {
  const config = resolveWakeContextConfig(parseCompanySettings(opts.companySettings));
  let context: Awaited<ReturnType<typeof buildWakeContext>> = null;
  let error: string | undefined;
  if (config.enabled && wake.taskId && wake.wakeReason !== 'agent_mail') {
    try {
      let commentBodies: string[] = [];
      if (wake.wakePayloadJson) {
        try {
          const payload = JSON.parse(wake.wakePayloadJson) as WakePayload;
          commentBodies = (payload.newComments ?? []).map((c) => c.body ?? '');
        } catch {
          /* malformed payload: header still built, no cited ids */
        }
      }
      const repo = typeof opts.repo === 'function' ? opts.repo() : opts.repo;
      context = await (opts.buildContext ?? buildWakeContext)(
        repo,
        {
          companyId: opts.companyId,
          agentId: opts.agentId,
          agentName: opts.agentName,
          agentUrlKey: opts.agentUrlKey,
          taskId: wake.taskId,
          wakeReason: wake.wakeReason,
          runStartedAt: opts.runStartedAt,
          commentBodies,
        },
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      opts.tracer?.warn('wake_context_failed', { taskId: wake.taskId, error });
      context = null;
    }
  }
  const { message, stats } = buildWakeMessageWithStats(wake, { context, budgets: config.budgets });
  return {
    wakeMessage: message,
    wakeContextSnapshot: {
      ...stats,
      enabled: config.enabled,
      source: config.source,
      messageSha256: createHash('sha256').update(message).digest('hex'),
      ...(error ? { error } : {}),
    },
  };
}
