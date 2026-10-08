import { formatWakeTime } from './format';

/** An approval as needed for inline claim reconciliation. */
export interface ApprovalClaimState {
  status: string;
  decidedAt: string | null;
}

/**
 * 8-hex approval tokens (optionally the start of a full UUID). Bounded so longer hex runs
 * (commit SHAs) never match; the replacement goes after the full UUID when one is present.
 */
const APPROVAL_TOKEN_RE =
  /(?<![0-9A-Za-z_])([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9A-Za-z_])/g;

/** Issue identifiers such as TOUR-531 (prefix of 2+ chars). */
const ISSUE_IDENTIFIER_RE = /(?<![0-9A-Za-z_-])([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![0-9A-Za-z_])/g;

/** Distinct 8-hex tokens in order of first appearance. */
export function extractApprovalTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(APPROVAL_TOKEN_RE)) seen.add(m[1]);
  return [...seen];
}

/** Distinct issue identifiers in order of first appearance. */
export function extractIssueIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(ISSUE_IDENTIFIER_RE)) seen.add(m[1]);
  return [...seen];
}

export function approvalAnnotation(a: ApprovalClaimState, refIso?: string | null): string {
  const when = a.decidedAt ? ` ${formatWakeTime(a.decidedAt, refIso)}` : '';
  return `⟨now ${a.status.toUpperCase()}${when}⟩`;
}

const PENDING_RE = /pending/i;

/**
 * WC5. After the first mention of each approval id that resolves to a non-pending approval, and
 * after any later mention within 25 chars before / 60 chars after the word "pending", insert
 * `⟨now <STATUS> <time>⟩`. Pending approvals are untouched; the comment's own words never change.
 */
export function annotateClaimsCounted(
  text: string,
  approvals: ReadonlyMap<string, ApprovalClaimState>,
  opts: { refIso?: string | null } = {},
): { text: string; count: number; ids: string[] } {
  const annotated = new Set<string>();
  let count = 0;
  const out = text.replace(APPROVAL_TOKEN_RE, (match: string, short: string, offset: number) => {
    const a = approvals.get(short);
    if (!a || a.status === 'pending') return match;
    const end = offset + match.length;
    const near = text.slice(Math.max(0, offset - 25), offset) + text.slice(end, end + 60);
    if (annotated.has(short) && !PENDING_RE.test(near)) return match;
    annotated.add(short);
    count++;
    return `${match} ${approvalAnnotation(a, opts.refIso)}`;
  });
  return { text: out, count, ids: [...annotated] };
}

export function annotateClaims(
  text: string,
  approvals: ReadonlyMap<string, ApprovalClaimState>,
  opts: { refIso?: string | null } = {},
): string {
  return annotateClaimsCounted(text, approvals, opts).text;
}
