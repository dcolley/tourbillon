/**
 * WID-2: the approval card shown in the assistant chat. Client-safe types and pure helpers (no db).
 *
 * The card is a view of one stored approval, read from `GET /api/approvals/:id/card` (Board only,
 * active company) and answered through the Board decide route (`POST /api/approvals/:id/decide`),
 * the same route and the same `applyApprovalDecision` claim as the /approval page. It carries no
 * tokens: links and files are opened from the approval page, where opening is recorded.
 */
import type { HitlAnswerType } from '@tourbillon/shared/hitl';

export interface ApprovalCardOption {
  value: string | number;
  label: string;
  description?: string;
}

export interface ApprovalCardItem {
  ref: string;
  kind: 'link' | 'attachment';
  label: string;
  mustOpen: boolean;
  opened: boolean;
}

export interface ApprovalCardResponse {
  status: string;
  /** Answer text (option labels); never a secret value. */
  answer?: string;
  reason?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface ApprovalCardData {
  id: string;
  /** Stored approval status: pending | approved | rejected | answered | declined | cancelled | expired. */
  status: string;
  /** The question, or the legacy title, or the approval type. */
  title: string;
  /** Legacy title when it differs from the question. */
  subtitle?: string;
  /** Legacy summary (approvals without a typed question). */
  summary?: string;
  requestedBy: string | null;
  createdAt: string;
  /** True when the approval carries a hitl v0 question. */
  typed: boolean;
  answerType: HitlAnswerType;
  options: ApprovalCardOption[];
  bounds: Record<string, number | string>;
  recommended?: { value: unknown; reason: string };
  default?: unknown;
  /** Answer values that need a reason (stringified for display and matching). */
  reasonRequired: Array<string | number>;
  risk?: { level?: string; reversible?: boolean };
  context?: string;
  items: ApprovalCardItem[];
  deadline: string | null;
  response?: ApprovalCardResponse;
  /** The Board approval page for this approval (links, files, full history). */
  detailsPath: string;
}

/** What the reviewer filled in on the card. */
export interface ApprovalCardInput {
  /** binary: approve | reject. Others: the answer (string, number or string[] for multi). */
  value?: unknown;
  reason?: string;
  decline?: boolean;
}

export type ApprovalCardBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/**
 * JSON body for `POST /api/approvals/:id/decide` from the card, in the same shape the /approval
 * form sends (legacy `decision` for binary, `status` + `value` otherwise). The route validates
 * everything again; this only refuses what the card can tell is incomplete.
 */
export function approvalCardDecisionBody(card: Pick<ApprovalCardData, 'answerType' | 'typed' | 'options'>, input: ApprovalCardInput): ApprovalCardBody {
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason : undefined;
  const withReason = (body: Record<string, unknown>) => ({ ok: true as const, body: reason ? { ...body, reason } : body });
  if (input.decline) {
    if (!card.typed) return { ok: false, error: 'This approval can only be approved or rejected.' };
    return withReason({ status: 'declined' });
  }
  if (card.answerType === 'secret') {
    return { ok: false, error: 'Secret answers must be encrypted on your device, which is not supported yet. Decline instead.' };
  }
  if (card.answerType === 'binary') {
    if (input.value !== 'approve' && input.value !== 'reject') return { ok: false, error: 'Choose approve or reject.' };
    return withReason({ decision: input.value === 'approve' ? 'approved' : 'rejected' });
  }
  if (isBlank(input.value)) return { ok: false, error: 'Give an answer first.' };
  let value = input.value;
  if (card.answerType === 'number' && typeof value === 'string') {
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())) return { ok: false, error: 'Enter a number.' };
    value = Number(value.trim());
  }
  if (card.answerType === 'multi' && !Array.isArray(value)) value = [value];
  if (card.answerType === 'single' || card.answerType === 'multi') {
    // Option values may be numbers; a form control gives strings.
    const byText = new Map(card.options.map((o) => [String(o.value), o.value]));
    const map = (v: unknown) => (byText.has(String(v)) ? byText.get(String(v)) : v);
    value = Array.isArray(value) ? value.map(map) : map(value);
  }
  return withReason({ status: 'answered', value });
}

/** Does this answer need a reason on this card? (Mirrors the server rule for display.) */
export function approvalCardNeedsReason(card: Pick<ApprovalCardData, 'answerType' | 'reasonRequired'>, value: unknown): boolean {
  if (card.reasonRequired.length === 0 || value === undefined) return false;
  const rr = card.reasonRequired.map(String);
  if (Array.isArray(value)) return value.some((v) => rr.includes(String(v)));
  return rr.includes(String(value));
}

/** Short message for a failed decide response (field messages first). */
export function approvalCardErrorText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; fields?: Array<{ message?: unknown }> };
  const fields = Array.isArray(b.fields) ? b.fields.map((f) => (typeof f?.message === 'string' ? f.message : '')).filter(Boolean) : [];
  if (fields.length > 0) return fields.join('; ');
  if (status === 409) return b.error === 'Expired' ? 'This request expired before a decision.' : 'This approval was already decided.';
  if (status === 404) return 'Approval not found.';
  if (status === 401 || status === 403) return 'Only the Board can answer this approval.';
  return typeof b.error === 'string' ? b.error : 'The answer could not be sent. Try again.';
}

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for the Board',
  approved: 'Approved',
  rejected: 'Rejected',
  answered: 'Answered',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
};
