import type { Approval } from '@tourbillon/db';
import type { HitlRequest, HitlResponse } from '@tourbillon/shared/hitl';

/** One-line text for a decided approval's response (status, answer, decided by). Never a secret. */
export function responseSummary(approval: Pick<Approval, 'hitlRequest' | 'hitlResponse'>): string | null {
  const r = approval.hitlResponse as HitlResponse | null;
  if (!r) return null;
  const req = approval.hitlRequest as HitlRequest | null;
  const parts: string[] = [`Response: ${r.status}`];
  if (r.status === 'answered' && r.value !== undefined) {
    if (req?.answerType === 'secret') parts.push('answer: (encrypted)');
    else {
      const label = (v: unknown) => req?.options?.find((o) => o.value === v)?.label ?? (typeof v === 'string' ? v : JSON.stringify(v));
      const text = Array.isArray(r.value) ? r.value.map(label).join(', ') : label(r.value);
      parts.push(`answer: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
    }
  }
  if (r.decidedBy) parts.push(`by ${r.decidedBy.display ?? r.decidedBy.id}`);
  return parts.join(' · ');
}

/** Has this deadline passed? (Kept out of the component body: it reads the clock.) */
export function deadlineHasPassed(deadline: Date | null | undefined): boolean {
  return deadline ? deadline.getTime() <= Date.now() : false;
}
