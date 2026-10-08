/**
 * Approval details (board UI `/approval/[approvalId]` and `GET /api/approvals/:id`).
 *
 * Pure logic over a small repo interface: company scoping, redaction (./approval-redaction, over
 * every field) and the history timeline. The Drizzle repo lives in ./approval-detail-repo so
 * this file stays testable.
 */
import { collectSecretValueEntries } from '@tourbillon/shared';
import {
  collectValuesUnderSensitiveKeys,
  createApprovalRedactor,
  PAYLOAD_DISPLAY_CAP,
  REDACTION_UNAVAILABLE,
  type KnownSecretValues,
} from './approval-redaction';

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
  /** Company settings, used only to collect secret values to scrub. */
  getCompanySettings(companyId: string): Promise<unknown>;
  /**
   * Secret values to scrub (vault secrets and agent runtime secrets of this company, LLM provider
   * keys/header values). Held in memory for redaction only: never logged or returned.
   * `vaultUnavailable` when vault rows could not be decrypted: free text is then hidden.
   */
  getSecretValues(companyId: string): Promise<KnownSecretValues>;
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
  /** Redacted (lib/approval-redaction) and clipped to APPROVAL_TITLE_MAX_CHARS. */
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
  approval: Omit<ApprovalRow, 'payload'> & {
    payload: unknown;
    /** True when the payload was cut for display (size/depth cap). */
    payloadTruncated: boolean;
    title: string;
    summary: string | null;
  };
  requester: { id: string; name: string; urlKey: string } | null;
  decidedBy: string | null;
  linkedIssues: Array<Omit<ApprovalIssueRow, 'companyId'> & { haltedByThis: boolean }>;
  /** Linked ids with no issue in this company (deleted, or never valid). */
  missingIssueIds: string[];
  history: ApprovalHistoryEvent[];
  /** Other approvals on the same linked issues (resubmissions show up here), newest first. */
  relatedApprovals: RelatedApproval[];
  /**
   * True when vault values could not be loaded: payload, title, summary, notes, HITLy error and
   * issue titles show REDACTION_UNAVAILABLE; status, dates, actors and ids still render.
   */
  redactionUnavailable: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const APPROVAL_TITLE_MAX_CHARS = 300;
export const APPROVAL_SUMMARY_MAX_CHARS = 2_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * Approval ids are opaque text (createId). Anything empty, longer than 128 chars or holding a
 * control character (Postgres refuses NUL in text, which was a 500) is rejected up front:
 * 400 from the API routes, not-found on the page.
 */
export function isValidApprovalId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id);
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
  // Only id + identifier: history never carries the issue title (or any other issue field).
  const issueRef = (id: string) => {
    const issue = opts.issuesById?.get(id);
    return issue ? { id: issue.id, identifier: issue.identifier } : { id, identifier: id.slice(0, 8) };
  };
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
  if (!companyId || !isValidApprovalId(approvalId)) return null;
  const approval = await repo.getApproval(companyId, approvalId);
  if (!approval || approval.companyId !== companyId) return null;

  const issueIds = Array.isArray(approval.issueIds) ? approval.issueIds : [];
  const [agent, issueRows, activity, settings, known, relatedRows] = await Promise.all([
    approval.requestedByAgentId ? repo.getAgent(companyId, approval.requestedByAgentId) : Promise.resolve(null),
    issueIds.length ? repo.getIssues(companyId, issueIds) : Promise.resolve([]),
    repo.getActivity(companyId, approval.id, issueIds),
    repo.getCompanySettings(companyId),
    // B3: if the secret values can't be loaded at all (query error…), hide free text; never a 500.
    repo.getSecretValues(companyId).catch((): KnownSecretValues => {
      console.warn('[approval redaction] secret values unavailable', { reason: 'load_failed' });
      return { values: [], vaultUnavailable: true };
    }),
    issueIds.length && repo.getRelatedApprovals
      ? repo.getRelatedApprovals(companyId, approval.id, issueIds)
      : Promise.resolve([] as ApprovalRow[]),
  ]);
  const requester = agent && agent.companyId === companyId ? agent : null;
  const issuesById = new Map(
    issueRows.filter((i) => i.companyId === companyId).map((i) => [i.id, i] as const),
  );

  // B1: one redactor for every field. Known values: vault + agent runtime secrets + provider
  // keys (repo), company settings, the requester, and anything held under a credential key in
  // the payload, activity details or a related approval's payload (e.g. hitlyResumeToken), so the
  // same value is also scrubbed where it was echoed (title, HITLy error, notes, related titles…).
  // B3: if the vault values can't all be loaded, every free-text field that could echo one is
  // hidden (redact.freeText) instead of rendered with an incomplete list.
  const redact = createApprovalRedactor([
    ...known.values,
    ...collectSecretValueEntries(settings).map(([, v]) => v),
    ...collectSecretValueEntries(requester?.runtimeConfig).map(([, v]) => v),
    ...collectValuesUnderSensitiveKeys(approval.payload),
    ...activity.flatMap((row) => collectValuesUnderSensitiveKeys(row.details)),
    ...relatedRows.flatMap((row) => collectValuesUnderSensitiveKeys(row.payload)),
  ], { vaultUnavailable: known.vaultUnavailable });
  const hidden = redact.unavailable;

  const rawPayload = isPlainObject(approval.payload) ? approval.payload : {};
  const { value: payload, truncated: payloadTruncated } = hidden
    ? { value: REDACTION_UNAVAILABLE, truncated: false }
    : redact.capped(approval.payload ?? {}, PAYLOAD_DISPLAY_CAP);
  // Scrub before clipping, so a cut can never leave half a secret behind.
  const title = clip(redact.freeText(str(rawPayload.title)?.trim() || approval.type), APPROVAL_TITLE_MAX_CHARS);
  const rawSummary = str(rawPayload.summary)?.trim();
  const summary = rawSummary ? clip(redact.freeText(rawSummary), APPROVAL_SUMMARY_MAX_CHARS) : null;
  const optText = (s: string | null) => (s ? redact.freeText(s) : s);

  const history = buildApprovalHistory(approval, activity, { requesterName: requester?.name ?? null, issuesById });
  const detail: ApprovalDetail = {
    approval: {
      ...approval,
      payload,
      payloadTruncated,
      title,
      summary,
      note: optText(approval.note),
      hitlyError: optText(approval.hitlyError),
    },
    requester: requester ? { id: requester.id, name: requester.name, urlKey: requester.urlKey } : null,
    decidedBy: decidedByLabel(approval),
    linkedIssues: issueIds
      .map((id) => issuesById.get(id))
      .filter((i): i is ApprovalIssueRow => Boolean(i))
      .map(({ companyId: _c, ...i }) => ({ ...i, title: redact.freeText(i.title), haltedByThis: i.boardApprovalId === approval.id })),
    missingIssueIds: issueIds.filter((id) => !issuesById.has(id)),
    history: hidden
      ? history.map((e) => ({
          ...e,
          ...(e.note ? { note: REDACTION_UNAVAILABLE } : {}),
          ...(e.kind === 'hitly_error' ? { text: `HITLy error: ${REDACTION_UNAVAILABLE}` } : {}),
        }))
      : history,
    redactionUnavailable: hidden,
    relatedApprovals: relatedApprovalsFor(approval, relatedRows, redact.freeText),
  };
  // B2: the same scrub over the whole object (note, hitlyError, issue titles, history text/notes,
  // actor names…), so the page, its RSC data and the JSON route all get this one copy.
  return redact.deep(detail);
}

/**
 * Same company, not this approval, shares a linked issue; newest first; capped. `scrub` is the
 * detail's redactor (titles are scrubbed before clipping, so a cut never leaves half a secret);
 * loadApprovalDetail also runs its deep redaction over the result.
 */
export function relatedApprovalsFor(
  approval: ApprovalRow,
  rows: ApprovalRow[],
  scrub: (s: string) => string = (s) => s,
): RelatedApproval[] {
  const mine = new Set(Array.isArray(approval.issueIds) ? approval.issueIds : []);
  const seen = new Set<string>();
  return rows
    .filter((r) => r.companyId === approval.companyId && r.id !== approval.id && !seen.has(r.id) && seen.add(r.id))
    .map((r) => {
      const payload = isPlainObject(r.payload) ? r.payload : {};
      return {
        id: r.id,
        title: clip(scrub(str(payload.title)?.trim() || r.type), APPROVAL_TITLE_MAX_CHARS),
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
    redactionUnavailable: d.redactionUnavailable,
  };
}
