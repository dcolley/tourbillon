/**
 * Approval details (board UI `/approval/[approvalId]` and `GET /api/approvals/:id`).
 *
 * Pure logic over a small repo interface: company scoping, payload redaction and the history
 * timeline. The Drizzle repo lives in ./approval-detail-repo so this file stays testable.
 */
import {
  REDACTED_SECRET_PLACEHOLDER,
  collectSecretValueEntries,
  redactAgentSecretsDeep,
  scrubSecretValues,
} from '@tourbillon/shared';

export interface ApprovalRow {
  id: string;
  companyId: string;
  type: string;
  status: string;
  requestedByAgentId: string | null;
  decidedByUserId: string | null;
  issueIds: string[];
  payload: unknown;
  note: string | null;
  decidedAt: Date | null;
  hitlyApprovalId: string | null;
  hitlyError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalAgentRow {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  runtimeConfig?: unknown;
}

export interface ApprovalIssueRow {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  status: string;
  boardApprovalId: string | null;
}

export interface ApprovalActivityRow {
  id: string;
  companyId: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: unknown;
  createdAt: Date;
}

/** Data access for the detail view. Every method is company-scoped. */
export interface ApprovalDetailRepo {
  getApproval(companyId: string, approvalId: string): Promise<ApprovalRow | null>;
  getAgent(companyId: string, agentId: string): Promise<ApprovalAgentRow | null>;
  getIssues(companyId: string, issueIds: string[]): Promise<ApprovalIssueRow[]>;
  /** activity_log rows about this approval or about its linked issues that cite it. */
  getActivity(companyId: string, approvalId: string, issueIds: string[]): Promise<ApprovalActivityRow[]>;
  /** Company settings, used only to collect secret values to scrub from the payload. */
  getCompanySettings(companyId: string): Promise<unknown>;
  /**
   * Other approvals in this company that share at least one linked issue (newest first).
   * Optional so older repos/tests without it simply show no related approvals.
   */
  getRelatedApprovals?(companyId: string, approvalId: string, issueIds: string[]): Promise<ApprovalRow[]>;
}

/** Max related approvals listed on the details page. */
export const RELATED_APPROVALS_LIMIT = 20;

export interface RelatedApproval {
  id: string;
  title: string;
  type: string;
  status: string;
  createdAt: Date;
  /** Linked issue ids shared with the approval being viewed. */
  sharedIssueIds: string[];
}

export type ApprovalHistoryKind =
  | 'created'
  | 'issue_halted'
  | 'hitly_sent'
  | 'hitly_error'
  | 'activity'
  | 'decided'
  | 'issue_released';

export interface ApprovalHistoryEvent {
  /** Null when the source has no timestamp (HITLy hand-off); ordered by `rank` after creation. */
  at: Date | null;
  kind: ApprovalHistoryKind;
  actor: string;
  text: string;
  note?: string;
  /** How to label `note`: a rejection reason is the board's feedback to the agent. */
  noteLabel?: 'Board feedback' | 'Note';
  issue?: { id: string; identifier: string };
  source: 'approvals' | 'activity_log';
}

export interface ApprovalDetail {
  approval: Omit<ApprovalRow, 'payload'> & { payload: unknown; title: string; summary: string | null };
  requester: { id: string; name: string; urlKey: string } | null;
  decidedBy: string | null;
  linkedIssues: Array<Omit<ApprovalIssueRow, 'companyId'> & { haltedByThis: boolean }>;
  /** Linked ids with no issue in this company (deleted, or never valid). */
  missingIssueIds: string[];
  history: ApprovalHistoryEvent[];
  /** Other approvals on the same linked issues (resubmissions show up here), newest first. */
  relatedApprovals: RelatedApproval[];
}

/** Payload keys that hold credentials for this approval flow (not covered by the shared helper). */
const APPROVAL_SECRET_KEYS = new Set(['hitlyResumeToken']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function redactApprovalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactApprovalKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      APPROVAL_SECRET_KEYS.has(k) && v != null && v !== '' ? REDACTED_SECRET_PLACEHOLDER : redactApprovalKeys(v),
    ]),
  );
}

/**
 * Payload for display. Same helper the approvals list uses over MCP (`redactAgentSecretsDeep`:
 * every runtimeConfig's secrets/API keys), plus the HITLy resume token, plus value-based
 * scrubbing of known secret values (company settings and the requesting agent's runtime config).
 */
export function redactApprovalPayload(payload: unknown, secretSources: unknown[] = []): unknown {
  const structural = redactApprovalKeys(redactAgentSecretsDeep(payload ?? {}));
  const entries = secretSources.flatMap((s) => collectSecretValueEntries(s));
  return entries.length ? scrubSecretValues(structural, entries) : structural;
}

/** Who decided, from `decidedByUserId` (null for in-app board decisions). */
export function decidedByLabel(a: Pick<ApprovalRow, 'status' | 'decidedByUserId'>): string | null {
  if (a.status === 'pending') return null;
  switch (a.decidedByUserId) {
    case null:
    case undefined:
    case '':
      return 'Board';
    case 'hitly':
      return 'HITLy';
    case 'mcp':
      return 'Board (via MCP)';
    default:
      return a.decidedByUserId;
  }
}

const RANK: Record<ApprovalHistoryKind, number> = {
  created: 0,
  issue_halted: 1,
  hitly_sent: 2,
  hitly_error: 3,
  activity: 4,
  decided: 5,
  issue_released: 6,
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Chronological timeline (oldest first) from the approval row and activity_log. Ties on time
 * are broken by event kind (creation → halt → HITLy → … → decision → release), then by input
 * order, so the result is deterministic.
 *
 * `approval.created` / `approval.decided` activity rows (written by every create/decide path
 * since #130's follow-up) are the source for those two events when present: they carry the
 * actor and note. Older approvals without them fall back to events derived from the approvals
 * row. At most one created and one decided event is ever shown.
 */
export function buildApprovalHistory(
  approval: ApprovalRow,
  activity: ApprovalActivityRow[],
  opts: { requesterName?: string | null; issuesById?: Map<string, { id: string; identifier: string }> } = {},
): ApprovalHistoryEvent[] {
  const requester = opts.requesterName ?? 'Unknown agent';
  const issueRef = (id: string) => opts.issuesById?.get(id) ?? { id, identifier: id.slice(0, 8) };
  const own = (row: ApprovalActivityRow) =>
    row.companyId === approval.companyId && row.entityType === 'approval' && row.entityId === approval.id;
  const actorOf = (row: ApprovalActivityRow) =>
    row.actorName ?? (row.actorId === approval.requestedByAgentId ? requester : row.actorId);
  const detailsOf = (row: ApprovalActivityRow) => (isPlainObject(row.details) ? row.details : {});
  const createdRow = activity.find((r) => own(r) && r.action === 'approval.created');
  const decidedRow = activity.find((r) => own(r) && r.action === 'approval.decided');
  const decisionText = (status: string | null) =>
    status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : `Decided: ${status ?? 'unknown'}`;

  const events: ApprovalHistoryEvent[] = [
    createdRow
      ? {
          at: createdRow.createdAt,
          kind: 'created',
          actor: actorOf(createdRow),
          text: `Requested (${approval.type})`,
          note: str(detailsOf(createdRow).note) ?? undefined,
          source: 'activity_log',
        }
      : {
          at: approval.createdAt,
          kind: 'created',
          actor: requester,
          text: `Requested (${approval.type})`,
          source: 'approvals',
        },
  ];
  if (approval.hitlyApprovalId) {
    events.push({ at: null, kind: 'hitly_sent', actor: 'System', text: `Sent to HITLy (${approval.hitlyApprovalId})`, source: 'approvals' });
  }
  if (approval.hitlyError) {
    events.push({ at: null, kind: 'hitly_error', actor: 'System', text: `HITLy error: ${approval.hitlyError}`, source: 'approvals' });
  }
  for (const row of activity) {
    if (row.companyId !== approval.companyId) continue; // defence in depth
    const d = detailsOf(row);
    const actor = actorOf(row);
    if (row.entityType === 'approval') {
      if (row.entityId !== approval.id) continue;
      // Lifecycle rows are handled once, above and below (never twice).
      if (row.action === 'approval.created' || row.action === 'approval.decided') continue;
      events.push({ at: row.createdAt, kind: 'activity', actor, text: row.action, note: str(d.note) ?? undefined, source: 'activity_log' });
      continue;
    }
    if (row.entityType !== 'issue') continue;
    const issue = issueRef(row.entityId);
    if (d.boardApprovalId === approval.id) {
      events.push({
        at: row.createdAt,
        kind: 'issue_halted',
        actor,
        text: `${issue.identifier} halted (${str(d.status) ?? 'blocked'}${str(d.priorStatus) ? `, was ${d.priorStatus}` : ''})`,
        issue,
        source: 'activity_log',
      });
    } else if (d.approvalId === approval.id) {
      events.push({
        at: row.createdAt,
        kind: 'issue_released',
        actor,
        text: `${issue.identifier} → ${str(d.status) ?? 'updated'} after ${str(d.decision) ?? 'decision'}`,
        issue,
        source: 'activity_log',
      });
    }
  }
  if (decidedRow) {
    const d = detailsOf(decidedRow);
    events.push({
      at: decidedRow.createdAt,
      kind: 'decided',
      actor: actorOf(decidedRow),
      text: decisionText(str(d.decision) ?? str(d.status) ?? approval.status),
      note: str(d.note) ?? undefined,
      source: 'activity_log',
    });
  } else if (approval.status !== 'pending' && approval.decidedAt) {
    events.push({
      at: approval.decidedAt,
      kind: 'decided',
      actor: decidedByLabel(approval) ?? 'Board',
      text: decisionText(approval.status),
      note: approval.note ?? undefined,
      source: 'approvals',
    });
  }
  // A rejection reason is the board's feedback to the requesting agent ("request changes").
  for (const e of events) {
    if (e.kind === 'decided' && e.note) e.noteLabel = e.text === 'Rejected' ? 'Board feedback' : 'Note';
  }
  // Untimed HITLy events sit right after creation.
  const time = (e: ApprovalHistoryEvent) => (e.at ?? approval.createdAt).getTime();
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => time(a.e) - time(b.e) || RANK[a.e.kind] - RANK[b.e.kind] || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * Load one approval for a company. Returns null for an unknown id AND for another company's id
 * (callers answer 404 for both, so ids don't leak across companies).
 */
export async function loadApprovalDetail(
  repo: ApprovalDetailRepo,
  companyId: string,
  approvalId: string,
): Promise<ApprovalDetail | null> {
  if (!companyId || !approvalId) return null;
  const approval = await repo.getApproval(companyId, approvalId);
  if (!approval || approval.companyId !== companyId) return null;

  const issueIds = Array.isArray(approval.issueIds) ? approval.issueIds : [];
  const [agent, issueRows, activity, settings, relatedRows] = await Promise.all([
    approval.requestedByAgentId ? repo.getAgent(companyId, approval.requestedByAgentId) : Promise.resolve(null),
    issueIds.length ? repo.getIssues(companyId, issueIds) : Promise.resolve([]),
    repo.getActivity(companyId, approval.id, issueIds),
    repo.getCompanySettings(companyId),
    issueIds.length && repo.getRelatedApprovals
      ? repo.getRelatedApprovals(companyId, approval.id, issueIds)
      : Promise.resolve([] as ApprovalRow[]),
  ]);
  const requester = agent && agent.companyId === companyId ? agent : null;
  const issuesById = new Map(
    issueRows.filter((i) => i.companyId === companyId).map((i) => [i.id, i] as const),
  );

  const payload = isPlainObject(approval.payload) ? approval.payload : {};
  const title = str(payload.title)?.trim() || approval.type;
  const summary = str(payload.summary)?.trim() || null;

  return {
    approval: {
      ...approval,
      payload: redactApprovalPayload(approval.payload, [settings, requester?.runtimeConfig]),
      title,
      summary,
    },
    requester: requester ? { id: requester.id, name: requester.name, urlKey: requester.urlKey } : null,
    decidedBy: decidedByLabel(approval),
    linkedIssues: issueIds
      .map((id) => issuesById.get(id))
      .filter((i): i is ApprovalIssueRow => Boolean(i))
      .map(({ companyId: _c, ...i }) => ({ ...i, haltedByThis: i.boardApprovalId === approval.id })),
    missingIssueIds: issueIds.filter((id) => !issuesById.has(id)),
    history: buildApprovalHistory(approval, activity, { requesterName: requester?.name ?? null, issuesById }),
    relatedApprovals: relatedApprovalsFor(approval, relatedRows),
  };
}

/** Same company, not this approval, shares a linked issue; newest first; capped. */
export function relatedApprovalsFor(approval: ApprovalRow, rows: ApprovalRow[]): RelatedApproval[] {
  const mine = new Set(Array.isArray(approval.issueIds) ? approval.issueIds : []);
  const seen = new Set<string>();
  return rows
    .filter((r) => r.companyId === approval.companyId && r.id !== approval.id && !seen.has(r.id) && seen.add(r.id))
    .map((r) => {
      const payload = isPlainObject(r.payload) ? r.payload : {};
      return {
        id: r.id,
        title: str(payload.title)?.trim() || r.type,
        type: r.type,
        status: r.status,
        createdAt: r.createdAt,
        sharedIssueIds: (Array.isArray(r.issueIds) ? r.issueIds : []).filter((id) => mine.has(id)),
      };
    })
    .filter((r) => r.sharedIssueIds.length > 0)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, RELATED_APPROVALS_LIMIT);
}

/** JSON body for `GET /api/approvals/:id` (dates as ISO strings). */
export function approvalDetailJson(d: ApprovalDetail) {
  const iso = (x: Date | null) => (x ? x.toISOString() : null);
  return {
    approval: {
      ...d.approval,
      createdAt: iso(d.approval.createdAt),
      updatedAt: iso(d.approval.updatedAt),
      decidedAt: iso(d.approval.decidedAt),
    },
    requester: d.requester,
    decidedBy: d.decidedBy,
    linkedIssues: d.linkedIssues,
    missingIssueIds: d.missingIssueIds,
    history: d.history.map((e) => ({ ...e, at: iso(e.at) })),
    relatedApprovals: d.relatedApprovals.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
  };
}
