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
  type ApprovalRedactor,
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
  const events: ApprovalHistoryEvent[] = [
    {
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
  const hasDecision = approval.status !== 'pending' && approval.decidedAt;
  for (const row of activity) {
    if (row.companyId !== approval.companyId) continue; // defence in depth
    const d = isPlainObject(row.details) ? row.details : {};
    const actor = row.actorName ?? (row.actorId === approval.requestedByAgentId ? requester : row.actorId);
    if (row.entityType === 'approval') {
      if (row.entityId !== approval.id) continue;
      if (row.action === 'approval.created') continue; // same as the row's own creation event
      if (row.action === 'approval.decided' && hasDecision) continue; // same as the decision event
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
  if (hasDecision) {
    events.push({
      at: approval.decidedAt,
      kind: 'decided',
      actor: decidedByLabel(approval) ?? 'Board',
      text: approval.status === 'approved' ? 'Approved' : approval.status === 'rejected' ? 'Rejected' : `Decided: ${approval.status}`,
      note: approval.note ?? undefined,
      source: 'approvals',
    });
  }
  // Untimed HITLy events sit right after creation.
  const time = (e: ApprovalHistoryEvent) => (e.at ?? approval.createdAt).getTime();
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => time(a.e) - time(b.e) || RANK[a.e.kind] - RANK[b.e.kind] || a.i - b.i)
    .map(({ e }) => e);
}

/** Per-approval sources whose secret values are scrubbed as well as the company-wide ones. */
export interface ApprovalRedactionSources {
  /** The requesting agent's runtimeConfig (its runtime secrets). */
  requesterRuntimeConfig?: unknown;
  /**
   * Payload / activity `details` objects: any value held under a credential key there (e.g.
   * hitlyResumeToken) is scrubbed everywhere it was echoed (title, HITLy error, notes…).
   */
  payloads?: unknown[];
}

/**
 * Company-wide known secret values: vault + agent runtime secrets + provider keys
 * (repo.getSecretValues) and company settings. Never throws (#130 B3): if either can't be
 * loaded, `vaultUnavailable` is set, so free text is hidden instead of rendered with an
 * incomplete list (and never a 500). Values are held in memory only, never logged.
 */
export async function loadApprovalKnownSecrets(
  repo: Pick<ApprovalDetailRepo, 'getSecretValues' | 'getCompanySettings'>,
  companyId: string,
): Promise<KnownSecretValues> {
  const unavailable = (source: string): null => {
    console.warn('[approval redaction] secret values unavailable', { reason: 'load_failed', source });
    return null;
  };
  const [known, settings] = await Promise.all([
    Promise.resolve()
      .then(() => repo.getSecretValues(companyId))
      .catch(() => unavailable('secret_values')),
    Promise.resolve()
      .then(() => repo.getCompanySettings(companyId))
      .then((v) => ({ v }), () => unavailable('company_settings')),
  ]);
  return {
    values: [...(known?.values ?? []), ...collectSecretValueEntries(settings?.v).map(([, v]) => v)],
    vaultUnavailable: !known || !settings || known.vaultUnavailable === true,
  };
}

/** The approval redactor for company-wide known values plus one approval's own sources. */
export function approvalRedactorFor(known: KnownSecretValues, sources: ApprovalRedactionSources = {}): ApprovalRedactor {
  return createApprovalRedactor(
    [
      ...known.values,
      ...collectSecretValueEntries(sources.requesterRuntimeConfig).map(([, v]) => v),
      ...(sources.payloads ?? []).flatMap((p) => collectValuesUnderSensitiveKeys(p)),
    ],
    { vaultUnavailable: known.vaultUnavailable },
  );
}

/**
 * One call for any surface that shows approval text (details page/API, list, MCP, mobile): loads
 * the company-wide values with the hide-on-error step inside, then builds the redactor. Use
 * `redactor.freeText` for free-text fields and `redactor.unavailable` to hide payloads.
 */
export async function loadApprovalRedactor(
  repo: Pick<ApprovalDetailRepo, 'getSecretValues' | 'getCompanySettings'>,
  companyId: string,
  sources: ApprovalRedactionSources = {},
): Promise<ApprovalRedactor> {
  return approvalRedactorFor(await loadApprovalKnownSecrets(repo, companyId), sources);
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
  const [agent, issueRows, activity, known] = await Promise.all([
    approval.requestedByAgentId ? repo.getAgent(companyId, approval.requestedByAgentId) : Promise.resolve(null),
    issueIds.length ? repo.getIssues(companyId, issueIds) : Promise.resolve([]),
    repo.getActivity(companyId, approval.id, issueIds),
    // B3: if the secret values can't be loaded (query error…), free text is hidden; never a 500.
    loadApprovalKnownSecrets(repo, companyId),
  ]);
  const requester = agent && agent.companyId === companyId ? agent : null;
  const issuesById = new Map(
    issueRows.filter((i) => i.companyId === companyId).map((i) => [i.id, i] as const),
  );

  // B1: one redactor for every field. Known values: vault + agent runtime secrets + provider
  // keys (repo), company settings, the requester, and anything held under a credential key in
  // the payload or activity details (e.g. hitlyResumeToken), so the same value is also scrubbed
  // where it was echoed (title, HITLy error, notes…).
  // B3: if the vault values can't all be loaded, every free-text field that could echo one is
  // hidden (redact.freeText) instead of rendered with an incomplete list.
  const redact = approvalRedactorFor(known, {
    requesterRuntimeConfig: requester?.runtimeConfig,
    payloads: [approval.payload, ...activity.map((row) => row.details)],
  });
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
  };
  // B2: the same scrub over the whole object (note, hitlyError, issue titles, history text/notes,
  // actor names…), so the page, its RSC data and the JSON route all get this one copy.
  return redact.deep(detail);
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
    redactionUnavailable: d.redactionUnavailable,
  };
}
