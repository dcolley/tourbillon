import {
  WAKE_HEADER_MAX_APPROVAL_ROWS,
  WAKE_HEADER_MAX_BLOCKERS,
  WAKE_HEADER_MAX_CHARS,
  WAKE_HEADER_MAX_OTHER_ISSUES,
  WAKE_HEADER_NOTE_CHARS,
} from './constants';
import { formatWakeTime, truncateEnd } from './format';
import { noteRemainder, sharedRulingPrefix } from './ruling';
import type { WakeApprovalRef, WakeLiveContext } from './types';

export const LIVE_STATE_TRUST_TEXT = 'trust this over anything said in comments';

export interface RenderHeaderInput {
  /** 8-hex ids cited in the comments being shown. */
  citedApprovalIds: ReadonlySet<string>;
  /** Issue identifiers cited in the comments being shown, most relevant first. */
  citedIdentifiers: readonly string[];
  maxChars?: number;
}

export interface RenderedHeader {
  text: string;
  approvalsListed: string[];
}

const shortId = (id: string) => id.slice(0, 8);

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/** WC2 AC3: linked ∪ cited; pending first, then decided_at desc, then id. */
export function listHeaderApprovals(ctx: WakeLiveContext, cited: ReadonlySet<string>): WakeApprovalRef[] {
  const seen = new Set<string>();
  const out: WakeApprovalRef[] = [];
  for (const a of ctx.approvals) {
    const s = shortId(a.id);
    if (seen.has(s)) continue;
    if (!a.linked && !cited.has(s)) continue;
    seen.add(s);
    out.push(a);
  }
  return out.sort((a, b) => {
    const pa = a.status === 'pending' ? 0 : 1;
    const pb = b.status === 'pending' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const d = ms(b.decidedAt) - ms(a.decidedAt);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

interface Shape {
  otherIssues: number;
  noteChars: number;
  rulingLine: boolean;
  approvalRows: number;
  titleChars: number;
}

/**
 * WC2: the authoritative LIVE STATE block. On overflow trims, in order: other issues, approval
 * note text, approval rows (then, as a last resort, the task title). Never exceeds maxChars.
 */
export function renderLiveStateHeader(ctx: WakeLiveContext, input: RenderHeaderInput): RenderedHeader {
  const maxChars = input.maxChars ?? WAKE_HEADER_MAX_CHARS;
  const ref = ctx.asOf;
  const when = (iso: string) => formatWakeTime(iso, ref);
  const approvals = listHeaderApprovals(ctx, input.citedApprovalIds);
  const decided = approvals.filter((a) => a.status !== 'pending');
  const ruling = sharedRulingPrefix(decided.map((a) => a.note));
  const rulingDate = (() => {
    if (!ruling) return null;
    const sharing = decided.filter((a) => (a.note ?? '').trim().startsWith(ruling.prefix));
    const days = new Set(sharing.map((a) => (a.decidedAt ? formatWakeTime(a.decidedAt).split(' ').slice(0, 2).join(' ') : '')));
    return days.size === 1 ? [...days][0] : null;
  })();

  const shown = new Set([ctx.task.identifier, ctx.parent?.identifier, ...ctx.blockers.map((b) => b.identifier)]);
  const statusByIdentifier = new Map(ctx.referencedIssues.map((i) => [i.identifier, i.status]));
  const otherIssues = input.citedIdentifiers
    .filter((id) => !shown.has(id) && statusByIdentifier.has(id))
    .map((id) => `${id} ${statusByIdentifier.get(id)}`);

  const since = ctx.lastActivityAt;
  const sinceMs = ms(since);
  const approvalDecisions = approvals.filter((a) => a.status !== 'pending' && ms(a.decidedAt) > sinceMs).length;
  const decisions = approvalDecisions + ctx.userCommentsSinceLastActivity;
  const pending = approvals.filter((a) => a.status === 'pending').length;

  const render = (s: Shape): string => {
    const L: string[] = [];
    L.push(`LIVE STATE (from the database at ${when(ref)} today; ${LIVE_STATE_TRUST_TEXT})`);
    const title = s.titleChars >= ctx.task.title.length ? ctx.task.title : truncateEnd(ctx.task.title, s.titleChars);
    L.push(`- Task ${ctx.task.identifier}: ${title}`);
    const a = ctx.task.assignee;
    const assignee =
      a.kind === 'self'
        ? `you (${ctx.agent.name})`
        : a.kind === 'agent'
          ? `${a.name ?? 'another agent'} (not you)`
          : a.kind === 'user'
            ? `${a.name ?? 'a Board user'} (user)`
            : 'unassigned';
    L.push(`  status ${ctx.task.status}, priority ${ctx.task.priority}, assignee: ${assignee}`);
    if (ctx.parent) L.push(`- Parent ${ctx.parent.identifier}: ${ctx.parent.status}`);
    const blockers = ctx.blockers.slice(0, WAKE_HEADER_MAX_BLOCKERS);
    for (const b of blockers) L.push(`- Blocked by ${b.identifier}: ${b.status}`);
    if (ctx.blockers.length > blockers.length) L.push(`- Blocked by: +${ctx.blockers.length - blockers.length} more`);

    if (approvals.length === 0) {
      L.push('- Approvals referenced on this issue: none');
    } else {
      L.push('- Approvals referenced on this issue (current status):');
      const useRuling = s.rulingLine && s.noteChars > 0 && ruling;
      if (useRuling) {
        const on = rulingDate ? `the ${rulingDate} decisions` : `${ruling.count} of these decisions`;
        L.push(`  Shared Board ruling text on ${on}: "${truncateEnd(ruling.prefix, 400)}"`);
      }
      const rows = approvals.slice(0, s.approvalRows);
      for (const r of rows) {
        const status = r.status.toUpperCase();
        const time = r.status === 'pending' ? ` (filed ${when(r.createdAt)})` : r.decidedAt ? ` ${when(r.decidedAt)}` : '';
        let text = '';
        if (s.noteChars > 0) {
          const raw = r.note?.trim()
            ? noteRemainder(r.note, useRuling ? ruling.prefix : null)
            : r.title?.trim()
              ? `re: ${r.title.trim().replace(/\s+/g, ' ')}`
              : '';
          if (raw) text = `: ${truncateEnd(raw, s.noteChars)}`;
        }
        L.push(`  - ${shortId(r.id)} ${status}${time}${text}`);
      }
      if (approvals.length > rows.length) L.push(`  - +${approvals.length - rows.length} more`);
      L.push(`  Pending among these: ${pending || 'none'}.`);
    }
    const sinceLabel = since ? when(since) : 'none on record';
    const listed = approvalDecisions > 0 && approvals.length <= s.approvalRows;
    const detail =
      ctx.userCommentsSinceLastActivity > 0
        ? ` (${approvalDecisions} approval decision${approvalDecisions === 1 ? '' : 's'}${listed ? ' listed above' : ''}, ${ctx.userCommentsSinceLastActivity} Board/user comment${ctx.userCommentsSinceLastActivity === 1 ? '' : 's'})`
        : listed
          ? ' (listed above)'
          : '';
    L.push(`- Board decisions since your last activity here (${sinceLabel}): ${decisions}${detail}.`);
    if (s.otherIssues > 0 && otherIssues.length > 0) {
      const head = otherIssues.slice(0, s.otherIssues);
      const more = otherIssues.length - head.length;
      L.push(`- Other issues mentioned: ${head.join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    }
    return L.join('\n');
  };

  const shape: Shape = {
    otherIssues: WAKE_HEADER_MAX_OTHER_ISSUES,
    noteChars: WAKE_HEADER_NOTE_CHARS,
    rulingLine: true,
    approvalRows: WAKE_HEADER_MAX_APPROVAL_ROWS,
    titleChars: Number.MAX_SAFE_INTEGER,
  };
  let text = render(shape);
  // 1. other issues
  while (text.length > maxChars && shape.otherIssues > 0) {
    shape.otherIssues--;
    text = render(shape);
  }
  // 2. approval note text (shorter, then none — the ruling line goes with it)
  for (const n of [60, 0]) {
    if (text.length <= maxChars) break;
    shape.noteChars = Math.min(shape.noteChars, n);
    shape.rulingLine = n > 0 && shape.rulingLine;
    text = render(shape);
  }
  // 3. approval rows
  while (text.length > maxChars && shape.approvalRows > 0) {
    shape.approvalRows--;
    text = render(shape);
  }
  // 4. last resort: title, then a hard cut
  if (text.length > maxChars) {
    shape.titleChars = Math.max(20, ctx.task.title.length - (text.length - maxChars));
    text = render(shape);
  }
  if (text.length > maxChars) text = truncateEnd(text, maxChars);

  const listedIds = approvals.slice(0, shape.approvalRows).map((a) => shortId(a.id));
  return { text, approvalsListed: listedIds };
}
