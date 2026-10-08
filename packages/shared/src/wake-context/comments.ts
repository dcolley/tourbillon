import { annotateClaimsCounted, type ApprovalClaimState } from './annotate';
import { capLines, compactLines, type WakeCommentTier } from './compact';
import { WAKE_P1_COMMENT_CAP, WAKE_P2_COMMENT_CAP } from './constants';
import { isNearDuplicate, shingles } from './dedupe';
import { formatWakeClock, formatWakeTime, truncateEnd } from './format';
import { classifyPriority, isCheckedOutNotice } from './priority';

export interface WakeCommentInput {
  id?: string;
  body: string;
  authorType: 'user' | 'agent' | string;
  authorName: string;
  createdAt: string;
}

export interface CommentSectionResult {
  /** Heading + lines (empty string when there are no comments). */
  text: string;
  considered: number;
  shown: number;
  hidden: number;
  dropped: number;
  deduped: number;
  condensed: number;
  annotated: number;
  /** Indexes (into the chronological input) of the comments shown, ascending. */
  shownIndexes: number[];
  /** Bodies of the comments shown in full or condensed (not dedupe markers). */
  shownBodies: string[];
}

const MIN_SHRUNK_P1 = 200;
/** WC5 AC3: state words in the comment (whole compacted body, not just the part shown). */
const STATE_WORDS_RE = /pending|blocked|still|not merged/i;

function chronological<T extends { createdAt: string }>(xs: readonly T[]): T[] {
  return xs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const d = new Date(a.c.createdAt).getTime() - new Date(b.c.createdAt).getTime();
      return d !== 0 && !Number.isNaN(d) ? d : a.i - b.i;
    })
    .map((x) => x.c);
}

interface Candidate {
  idx: number;
  c: WakeCommentInput;
  tier: WakeCommentTier;
  isNewest: boolean;
  lines: string[];
  sh: Set<string>;
}

interface Picked {
  idx: number;
  line: string;
  marker: boolean;
  condensed: boolean;
  annotated: number;
  sh: Set<string>;
}

/**
 * WC1 + WC3–WC5 comment section ("v2"): newest-first fill under `budget` chars (heading
 * included), P1 before P2, near-duplicate markers, inline approval status annotations, then
 * displayed oldest→newest.
 */
export function renderCommentSectionV2(
  comments: readonly WakeCommentInput[],
  opts: {
    budget: number;
    agentName?: string | null;
    agentUrlKey?: string | null;
    approvals: ReadonlyMap<string, ApprovalClaimState>;
    refIso?: string | null;
    p1Cap?: number;
    p2Cap?: number;
  },
): CommentSectionResult {
  const p1Cap = opts.p1Cap ?? WAKE_P1_COMMENT_CAP;
  const p2Cap = opts.p2Cap ?? WAKE_P2_COMMENT_CAP;
  const all = chronological(comments);
  const n = all.length;
  const empty: CommentSectionResult = {
    text: '', considered: n, shown: 0, hidden: 0, dropped: 0, deduped: 0, condensed: 0, annotated: 0,
    shownIndexes: [], shownBodies: [],
  };
  if (n === 0) return empty;

  let hidden = 0;
  const visible: Array<{ idx: number; c: WakeCommentInput; lines: string[] }> = [];
  all.forEach((c, idx) => {
    if (isCheckedOutNotice(c.body)) {
      hidden++;
      return;
    }
    const lines = compactLines(c.body);
    if (lines.length === 0) {
      hidden++;
      return;
    }
    visible.push({ idx, c, lines });
  });
  const newestIdx = visible.length ? visible[visible.length - 1].idx : -1;
  const cands: Candidate[] = visible.map((v) => {
    const isNewest = v.idx === newestIdx;
    return {
      ...v,
      isNewest,
      tier: classifyPriority({
        authorType: v.c.authorType,
        authorName: v.c.authorName,
        body: v.c.body,
        isNewest,
        agentName: opts.agentName,
        agentUrlKey: opts.agentUrlKey,
      }),
      sh: shingles(v.lines.join(' ')),
    };
  });

  const heading = (shown: number, dropped: number) =>
    `RECENT COMMENTS (filled newest-first, shown oldest→newest; last ${n}: ${shown} shown, ${hidden} hidden, ${dropped} dropped for space)`;
  // Reserve the widest heading these counts can produce; each line then costs its length + 1 ('\n').
  const linesBudget = opts.budget - heading(n, n).length;
  let used = 0;
  const picked = new Map<number, Picked>();
  const fits = (line: string) => used + line.length + 1 <= linesBudget;

  const render = (cand: Candidate, cap: number): { line: string; annotated: number } => {
    const { text } = capLines(cand.lines, cap);
    const ann = annotateClaimsCounted(text, opts.approvals, { refIso: opts.refIso });
    const condensed = cand.tier === 2;
    const asOf =
      condensed && !cand.isNewest && STATE_WORDS_RE.test(cand.lines.join(' '))
        ? ` [as of ${formatWakeTime(cand.c.createdAt, opts.refIso)}; verify state against LIVE STATE]`
        : '';
    const prefix = `- [${formatWakeTime(cand.c.createdAt, opts.refIso)}] ${cand.c.authorName}${condensed ? ' (condensed)' : ''}${asOf}: `;
    return { line: `${prefix}${ann.text}`, annotated: ann.count };
  };

  const take = (cand: Candidate, allowShrink: boolean) => {
    // WC4: near-duplicate of a newer comment already selected.
    for (const p of picked.values()) {
      if (p.idx > cand.idx && !p.marker && isNearDuplicate(cand.sh, p.sh)) {
        const newer = all[p.idx];
        const line = `- [${formatWakeTime(cand.c.createdAt, opts.refIso)}] ${cand.c.authorName}: (near-duplicate of the newer ${newer.authorName} ${formatWakeClock(newer.createdAt)} comment, omitted)`;
        if (fits(line)) {
          picked.set(cand.idx, { idx: cand.idx, line, marker: true, condensed: false, annotated: 0, sh: cand.sh });
          used += line.length + 1;
        }
        return;
      }
    }
    const cap = cand.tier === 1 ? p1Cap : p2Cap;
    let r = render(cand, cap);
    // Shrink a P1 comment into the room left rather than dropping it.
    let curCap = cap;
    while (allowShrink && !fits(r.line)) {
      const over = used + r.line.length + 1 - linesBudget;
      curCap = Math.min(curCap - over, curCap - 1);
      if (curCap < MIN_SHRUNK_P1) break;
      r = render(cand, curCap);
    }
    if (!fits(r.line)) {
      if (!cand.isNewest) return;
      // The newest comment is always included (WC1 AC2): hard-cut as a last resort.
      r = { line: truncateEnd(r.line, Math.max(linesBudget - used - 1, 1)), annotated: r.annotated };
    }
    picked.set(cand.idx, {
      idx: cand.idx, line: r.line, marker: false, condensed: cand.tier === 2, annotated: r.annotated, sh: cand.sh,
    });
    used += r.line.length + 1;
  };

  const newestFirst = [...cands].reverse();
  const newest = newestFirst.find((c) => c.isNewest);
  if (newest) take(newest, true);
  // P2 is skipped before P1: every P1 gets its chance before any P2 (WC3 AC6).
  for (const c of newestFirst) if (!c.isNewest && c.tier === 1) take(c, true);
  for (const c of newestFirst) if (!c.isNewest && c.tier === 2) take(c, false);

  const ordered = [...picked.values()].sort((a, b) => a.idx - b.idx);
  const shown = ordered.length;
  const dropped = cands.length - shown;
  const text = [heading(shown, dropped), ...ordered.map((p) => p.line)].join('\n');
  return {
    text,
    considered: n,
    shown,
    hidden,
    dropped,
    deduped: ordered.filter((p) => p.marker).length,
    condensed: ordered.filter((p) => p.condensed).length,
    annotated: ordered.reduce((s, p) => s + p.annotated, 0),
    shownIndexes: ordered.map((p) => p.idx),
    shownBodies: ordered.filter((p) => !p.marker).map((p) => all[p.idx].body),
  };
}

/**
 * WC1 only ("t1", flag off / no live context): newest-first fill of verbatim comments under
 * `budget`, newest always included (capped at the P1 cap), displayed oldest→newest.
 */
export function renderCommentSectionT1(
  comments: readonly WakeCommentInput[],
  opts: { budget: number; p1Cap?: number },
): CommentSectionResult {
  const p1Cap = opts.p1Cap ?? WAKE_P1_COMMENT_CAP;
  const all = chronological(comments);
  const n = all.length;
  const res: CommentSectionResult = {
    text: '', considered: n, shown: 0, hidden: 0, dropped: 0, deduped: 0, condensed: 0, annotated: 0,
    shownIndexes: [], shownBodies: [],
  };
  if (n === 0) return res;
  const heading = (shown: number, dropped: number) =>
    `Recent issue comments (filled newest-first, shown oldest→newest; last ${n}: ${shown} shown, 0 hidden, ${dropped} dropped for space):`;
  const linesBudget = opts.budget - heading(n, n).length;
  const lines: Array<{ idx: number; line: string }> = [];
  let used = 0;
  for (let idx = n - 1; idx >= 0; idx--) {
    const c = all[idx];
    const prefix = `- [${c.createdAt}] ${c.authorName}: `;
    let line = `${prefix}${c.body}`;
    if (idx === n - 1) {
      if (c.body.length > p1Cap) line = `${prefix}${truncateEnd(c.body, p1Cap)}`;
      if (line.length + 1 > linesBudget) line = truncateEnd(line, Math.max(linesBudget - 1, 1));
    } else if (used + line.length + 1 > linesBudget) {
      break; // contiguous newest window
    }
    lines.push({ idx, line });
    used += line.length + 1;
  }
  lines.reverse();
  const shown = lines.length;
  const dropped = n - shown;
  res.text = [heading(shown, dropped), ...lines.map((l) => l.line)].join('\n');
  res.shown = shown;
  res.dropped = dropped;
  res.shownIndexes = lines.map((l) => l.idx);
  res.shownBodies = lines.map((l) => all[l.idx].body);
  return res;
}
