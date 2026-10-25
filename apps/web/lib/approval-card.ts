/**
 * WID-2: server side of the assistant chat's approval card. Builds the card view of one approval
 * (company-scoped) from the stored `hitl/request/v0` and `hitl/response/v0`.
 *
 * Built field by field, never from `payload` as a whole: payload can hold resume tokens. Links and
 * attachments are listed by label only (no URL, no `/o/` token); they are opened from the approval
 * page, where opening is recorded. A secret answer is never shown.
 */
import { db, approvals, agents } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { effectiveReasonRequired, type HitlRequest, type HitlResponse } from '@tourbillon/shared/hitl';
import type { HitlEventRow } from '@tourbillon/db';
import { BOARD_REVIEWER, hitlRequestOf, loadHitlEvents, openedRefsOf, recordReviewerEvent } from './hitl-host';
import type { ApprovalCardData, ApprovalCardItem, ApprovalCardResponse } from './approval-card-view';

type ApprovalRow = typeof approvals.$inferSelect;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function answerText(req: HitlRequest | null, value: unknown): string {
  if (req?.answerType === 'secret') return '(encrypted)';
  if (!req || req.answerType === 'binary') {
    if (value === 'approve') return 'Approve';
    if (value === 'reject') return 'Reject';
  }
  const one = (v: unknown) => req?.options?.find((o) => o.value === v)?.label ?? (typeof v === 'string' ? v : JSON.stringify(v));
  const text = Array.isArray(value) ? value.map(one).join(', ') : one(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function responseOf(row: ApprovalRow, req: HitlRequest | null): ApprovalCardResponse | undefined {
  if (row.status === 'pending') return undefined;
  const r = row.hitlResponse as HitlResponse | null;
  const decidedAt = row.decidedAt ? new Date(row.decidedAt).toISOString() : undefined;
  if (!r) {
    return { status: row.status, ...(str(row.note) ? { reason: row.note as string } : {}), ...(decidedAt ? { decidedAt } : {}) };
  }
  return {
    status: r.status,
    ...(r.status === 'answered' && r.value !== undefined ? { answer: answerText(req, r.value) } : {}),
    ...(str(r.reason) ? { reason: r.reason } : {}),
    ...(r.decidedBy ? { decidedBy: r.decidedBy.display ?? r.decidedBy.id } : {}),
    ...(decidedAt ? { decidedAt } : {}),
  };
}

/** The card view of one approval. Pure: no db, no clock. */
export function approvalCardDataOf(
  row: ApprovalRow,
  input: { requesterName: string | null; events?: HitlEventRow[] },
): ApprovalCardData {
  const req = hitlRequestOf(row);
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const legacyTitle = str(payload.title);
  const opened = openedRefsOf(input.events ?? []);
  const items: ApprovalCardItem[] = [
    ...(req?.context?.links ?? []).map((l) => ({ ref: l.ref, kind: 'link' as const, label: l.label, mustOpen: !!l.mustOpen, opened: opened.has(l.ref) })),
    ...(req?.context?.attachments ?? []).map((a) => ({ ref: a.ref, kind: 'attachment' as const, label: a.name, mustOpen: !!a.mustOpen, opened: opened.has(a.ref) })),
  ];
  const bounds: Record<string, number | string> = {};
  for (const [k, v] of Object.entries((req?.bounds ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'string') bounds[k] = v;
  }
  const response = responseOf(row, req);
  return {
    id: row.id,
    status: row.status,
    title: req?.question ?? legacyTitle ?? row.type,
    ...(req && legacyTitle && legacyTitle !== req.question ? { subtitle: legacyTitle } : {}),
    ...(!req && str(payload.summary) ? { summary: payload.summary as string } : {}),
    requestedBy: input.requesterName,
    createdAt: new Date(row.createdAt).toISOString(),
    typed: !!req,
    answerType: req?.answerType ?? 'binary',
    options: (req?.options ?? []).map((o) => ({ value: o.value, label: o.label, ...(o.description ? { description: o.description } : {}) })),
    bounds,
    ...(req?.recommended && req.answerType !== 'secret' ? { recommended: { value: req.recommended.value, reason: req.recommended.reason } } : {}),
    ...(req && req.default !== undefined && req.answerType !== 'secret' ? { default: req.default } : {}),
    reasonRequired: req ? effectiveReasonRequired(req) : [],
    ...(req?.risk ? { risk: { ...(req.risk.level ? { level: req.risk.level } : {}), ...(req.risk.reversible !== undefined ? { reversible: req.risk.reversible } : {}) } } : {}),
    ...(str(req?.context?.markdown) ? { context: req!.context!.markdown } : {}),
    items,
    deadline: row.deadline ? new Date(row.deadline).toISOString() : null,
    ...(response ? { response } : {}),
    detailsPath: `/approval/${row.id}`,
  };
}

/**
 * Load the card for the Board in this company, or null (missing or another company's).
 * Records `presented` once when asked and the approval is still pending.
 */
export async function loadApprovalCard(
  companyId: string,
  approvalId: string,
  opts: { recordPresented: boolean },
): Promise<ApprovalCardData | null> {
  const [found] = await db
    .select({ approval: approvals, agent: agents })
    .from(approvals)
    .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
    .where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)))
    .limit(1);
  if (!found) return null;
  const row = found.approval;
  if (opts.recordPresented && row.status === 'pending' && !row.presentedAt) {
    await recordReviewerEvent({ companyId, approvalId, type: 'presented', actor: BOARD_REVIEWER });
  }
  const events = row.hitlRequest ? await loadHitlEvents(db, companyId, approvalId) : [];
  return approvalCardDataOf(row, { requesterName: found.agent?.name ?? null, events });
}
