/**
 * APR-2: host side of hitl v0 for approvals. Builds `hitl/response/v0` objects, appends hash-chained
 * `hitl/event/v0` reviewer events, and issues `/o/<token>` link tokens.
 *
 * Tokens are opaque, bound to one approval + item + reviewer, and never returned by an API or
 * written to a log. Redeeming one also needs a board session in the token's company.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { db, approvals, hitlEvents, hitlLinkTokens, type Approval, type HitlEventRow } from '@tourbillon/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { ApprovalOutcomeStatus, ApprovalWakeResponse } from '@tourbillon/shared';
import {
  HITL_EVENT_SPEC,
  HITL_RESPONSE_SPEC,
  type HitlDecidedBy,
  type HitlEvent,
  type HitlEventType,
  type HitlRequest,
  type HitlResponse,
  type HitlResponseStatus,
} from '@tourbillon/shared/hitl';
import { hitlEventHash } from '@tourbillon/shared/hitl-hash';

type DbLike = typeof db;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = DbLike | DbTransaction;

export type HitlActor = { kind: 'human' | 'group' | 'service'; id: string };

/** Who decides on each path. The Board decides as a group. Expiry has no decider. */
export const BOARD_DECIDER: HitlDecidedBy = { kind: 'group', id: 'board', display: 'Board' };
export const HITLY_DECIDER: HitlDecidedBy = { kind: 'service', id: 'hitly', display: 'HITLy' };
export const MCP_DECIDER: HitlDecidedBy = { kind: 'service', id: 'mcp', display: 'MCP' };
/** The reviewer the dashboard records events and link tokens for. */
export const BOARD_REVIEWER: HitlActor = { kind: 'group', id: 'board' };

/** The stored request, or null for a legacy approval. Stored requests were validated on ingest. */
export function hitlRequestOf(row: Pick<Approval, 'hitlRequest'>): HitlRequest | null {
  const r = row.hitlRequest as HitlRequest | null | undefined;
  return r && typeof r === 'object' ? r : null;
}

/** The answer type of an approval; a legacy approval is a binary question. */
export function answerTypeOf(row: Pick<Approval, 'hitlRequest'>): HitlRequest['answerType'] {
  return hitlRequestOf(row)?.answerType ?? 'binary';
}

/** Stored status → `hitl/response/v0` status. approved / rejected are binary answers. */
export function responseStatusOf(outcome: ApprovalOutcomeStatus): HitlResponseStatus {
  if (outcome === 'approved' || outcome === 'rejected' || outcome === 'answered') return 'answered';
  return outcome;
}

/** Binary answer value for a stored status (approve / reject), or undefined. */
export function binaryValueOf(outcome: ApprovalOutcomeStatus): 'approve' | 'reject' | undefined {
  return outcome === 'approved' ? 'approve' : outcome === 'rejected' ? 'reject' : undefined;
}

/** Issue-restore effect of a stored status: an answer moves work on; anything else keeps it blocked. */
export function restoreEffectOf(outcome: ApprovalOutcomeStatus): 'approved' | 'rejected' {
  return outcome === 'approved' || outcome === 'answered' ? 'approved' : 'rejected';
}

export function rowToHitlEvent(row: HitlEventRow): HitlEvent {
  return {
    spec: HITL_EVENT_SPEC,
    id: row.id,
    requestId: row.approvalId,
    type: row.type,
    ...(row.itemRef ? { itemRef: row.itemRef } : {}),
    at: row.at.toISOString(),
    actor: { kind: row.actorKind, id: row.actorId },
    source: row.source,
    ...(row.data ? { data: row.data as Record<string, unknown> } : {}),
    prevHash: row.prevHash ?? null,
    hash: row.hash,
  };
}

export async function loadHitlEvents(ex: Executor, companyId: string, approvalId: string): Promise<HitlEventRow[]> {
  return ex
    .select()
    .from(hitlEvents)
    .where(and(eq(hitlEvents.approvalId, approvalId), eq(hitlEvents.companyId, companyId)))
    .orderBy(asc(hitlEvents.seq));
}

/**
 * Append one host event to an approval's chain. The caller must hold the approval row lock (the
 * decide claim does; `recordReviewerEvent` takes it), so seq and prevHash cannot race.
 */
export async function appendHitlEvent(
  tx: DbTransaction,
  input: { companyId: string; approvalId: string; type: HitlEventType; itemRef?: string; actor: HitlActor; at?: Date },
): Promise<HitlEventRow> {
  const [last] = await tx
    .select({ seq: hitlEvents.seq, hash: hitlEvents.hash })
    .from(hitlEvents)
    .where(eq(hitlEvents.approvalId, input.approvalId))
    .orderBy(desc(hitlEvents.seq))
    .limit(1);
  const at = input.at ?? new Date();
  const id = randomUUID();
  const event: Omit<HitlEvent, 'hash'> = {
    spec: HITL_EVENT_SPEC,
    id,
    requestId: input.approvalId,
    type: input.type,
    ...(input.itemRef ? { itemRef: input.itemRef } : {}),
    at: at.toISOString(),
    actor: { kind: input.actor.kind, id: input.actor.id },
    source: 'host',
    prevHash: last?.hash ?? null,
  };
  const hash = hitlEventHash(event as Record<string, unknown>);
  const [row] = await tx
    .insert(hitlEvents)
    .values({
      id,
      companyId: input.companyId,
      approvalId: input.approvalId,
      seq: (last?.seq ?? 0) + 1,
      type: input.type,
      itemRef: input.itemRef ?? null,
      at,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      source: 'host',
      prevHash: last?.hash ?? null,
      hash,
    })
    .returning();
  return row;
}

/**
 * Record a reviewer event (`presented` or `opened`) on a pending approval in this company.
 * Locks the approval row first. Returns false (nothing written) when the approval is not pending
 * or not in this company; `presented` is written once, and also sets approvals.presented_at.
 */
export async function recordReviewerEvent(input: {
  companyId: string;
  approvalId: string;
  type: 'presented' | 'opened';
  itemRef?: string;
  actor?: HitlActor;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: approvals.id, status: approvals.status, presentedAt: approvals.presentedAt })
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)))
      .for('update');
    if (!row || row.status !== 'pending') return false;
    if (input.type === 'presented' && row.presentedAt) return false;
    const now = new Date();
    await appendHitlEvent(tx, {
      companyId: input.companyId,
      approvalId: input.approvalId,
      type: input.type,
      itemRef: input.itemRef,
      actor: input.actor ?? BOARD_REVIEWER,
      at: now,
    });
    if (input.type === 'presented') {
      await tx
        .update(approvals)
        .set({ presentedAt: now })
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId)));
    }
    return true;
  });
}

/** Reviewable items of a request (links and attachments), in request order. */
export function hitlItemsOf(req: HitlRequest | null): Array<{ ref: string; sha256: string | null; url?: string; mustOpen: boolean; label: string }> {
  if (!req?.context) return [];
  return [
    ...(req.context.links ?? []).map((l) => ({ ref: l.ref, sha256: null, url: l.url, mustOpen: !!l.mustOpen, label: l.label })),
    ...(req.context.attachments ?? []).map((a) => ({ ref: a.ref, sha256: a.sha256, url: a.url, mustOpen: !!a.mustOpen, label: a.name })),
  ];
}

/** Refs the reviewer has opened, from the recorded `opened` events. */
export function openedRefsOf(events: HitlEventRow[]): Set<string> {
  return new Set(events.filter((e) => e.type === 'opened' && e.itemRef).map((e) => e.itemRef as string));
}

/** Build the `hitl/response/v0` for a decided approval. `signature` is null in APR-2. */
export function buildHitlResponse(input: {
  approval: Pick<Approval, 'id' | 'hitlRequest' | 'presentedAt'>;
  outcome: ApprovalOutcomeStatus;
  value?: unknown;
  reason?: string;
  decidedBy?: HitlDecidedBy;
  decidedAt: Date;
  events: HitlEventRow[];
}): HitlResponse {
  const request = hitlRequestOf(input.approval);
  const status = responseStatusOf(input.outcome);
  const value = status === 'answered' ? (input.value ?? binaryValueOf(input.outcome)) : undefined;
  const events = input.events.map(rowToHitlEvent);
  const opened = (ref: string) => events.filter((e) => e.type === 'opened' && e.itemRef === ref).map((e) => e.at);
  const reason = input.reason?.trim() ? input.reason : undefined;
  return {
    spec: HITL_RESPONSE_SPEC,
    requestId: input.approval.id,
    status,
    ...(value !== undefined ? { value: value as HitlResponse['value'] } : {}),
    ...(reason && status !== 'expired' ? { reason } : {}),
    ...(status !== 'expired' && input.decidedBy ? { decidedBy: input.decidedBy } : {}),
    ...(status !== 'expired' ? { decidedAt: input.decidedAt.toISOString() } : {}),
    ...(request?.action ? { argsHash: request.action.argsHash } : {}),
    signature: null,
    activity: {
      presentedAt: input.approval.presentedAt ? input.approval.presentedAt.toISOString() : null,
      items: hitlItemsOf(request).map((i) => ({ ref: i.ref, sha256: i.sha256, openedAt: opened(i.ref) })),
      events,
    },
  };
}

/** The response fields an approval_resolved wake carries. Secret values never go in a wake. */
export function wakeResponseOf(response: HitlResponse, answerType: string): ApprovalWakeResponse {
  const secret = answerType === 'secret';
  return {
    status: response.status,
    ...(response.status === 'answered' && !secret && response.value !== undefined ? { value: response.value } : {}),
    ...(response.status === 'answered' && secret ? { encrypted: true } : {}),
    ...(response.reason ? { reason: response.reason } : {}),
    ...(response.decidedBy ? { decidedBy: response.decidedBy } : {}),
    answerType,
  };
}

// ---- /o/<token> link tokens ---------------------------------------------------------------------

/** '' is the approval's own details page; spec refs are never empty, so it cannot collide. */
export const DETAILS_ITEM_REF = '';

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The reviewer's token for one item, created on first use (stable per approval + item + reviewer). */
export async function linkTokenFor(input: {
  companyId: string;
  approvalId: string;
  itemRef: string;
  reviewer?: HitlActor;
}): Promise<string> {
  const reviewer = input.reviewer ?? BOARD_REVIEWER;
  await db
    .insert(hitlLinkTokens)
    .values({
      token: newToken(),
      companyId: input.companyId,
      approvalId: input.approvalId,
      itemRef: input.itemRef,
      reviewerKind: reviewer.kind,
      reviewerId: reviewer.id,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ token: hitlLinkTokens.token })
    .from(hitlLinkTokens)
    .where(
      and(
        eq(hitlLinkTokens.approvalId, input.approvalId),
        eq(hitlLinkTokens.companyId, input.companyId),
        eq(hitlLinkTokens.itemRef, input.itemRef),
        eq(hitlLinkTokens.reviewerId, reviewer.id),
      ),
    )
    .limit(1);
  if (!row) throw new Error('link token not stored');
  return row.token;
}

/** Tokens for every item of an approval (ref → `/o/<token>` path). */
export async function linkPathsFor(input: { companyId: string; approvalId: string; refs: string[] }): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of input.refs) {
    out[ref] = `/o/${await linkTokenFor({ companyId: input.companyId, approvalId: input.approvalId, itemRef: ref })}`;
  }
  return out;
}

/** Look a token up in one company. Another company's token, or an unknown one, is null. */
export async function resolveLinkToken(token: string, companyId: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db
    .select()
    .from(hitlLinkTokens)
    .where(and(eq(hitlLinkTokens.token, token), eq(hitlLinkTokens.companyId, companyId)))
    .limit(1);
  return row ?? null;
}
