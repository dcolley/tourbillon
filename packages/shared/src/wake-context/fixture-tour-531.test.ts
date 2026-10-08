/**
 * The TOUR-531 replay (spec §6, run 6f24587d): golden output plus the WC1–WC6 fixture checks.
 * Regenerate the golden file only on an intended format change:
 *   UPDATE_WAKE_GOLDEN=1 npx tsx --test src/wake-context/fixture-tour-531.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWakeMessage, buildWakeMessageWithStats } from '../wake-message';
import { loadTour531Fixture, tour531Context, tour531Job } from './__fixtures__/tour-531';
import { WAKE_P2_COMMENT_CAP, WAKE_TOTAL_SOFT_MAX_CHARS } from './constants';

const GOLDEN = join(__dirname, '__fixtures__', 'tour-531-6f24587d.golden.txt');
const fx = loadTour531Fixture();
const { message, stats } = buildWakeMessageWithStats(tour531Job(fx), { context: tour531Context(fx) });
const header = message.slice(message.indexOf('LIVE STATE'), message.indexOf('\n\nRECENT COMMENTS'));
const lines = message.split('\n');
const commentLine = (time: string, author: string) => lines.find((l) => l.startsWith(`- [${time}] ${author}`));

describe('TOUR-531 fixture (run 6f24587d)', () => {
  it('golden: full rendered message, total <= 7,500 chars', () => {
    if (process.env.UPDATE_WAKE_GOLDEN === '1') writeFileSync(GOLDEN, message);
    assert.equal(message, readFileSync(GOLDEN, 'utf8'));
    assert.ok(message.length <= WAKE_TOTAL_SOFT_MAX_CHARS, String(message.length));
  });

  it('WC1: contains "Board answered a0000006"; the stale 19:02Z comment is not shown', () => {
    assert.ok(message.includes('Board answered a0000006'));
    assert.ok(!message.includes('Oct 7 19:02Z'));
    assert.ok(!message.includes('Parked (re-verify, ~19:00Z wake)'));
    // T1 alone keeps the newest too.
    const t1 = buildWakeMessage(tour531Job(fx));
    assert.ok(t1.includes('Board answered `a0000006`'));
    assert.ok(!t1.includes('2026-10-07T19:02:40.205Z'));
  });

  it('WC2: header lists live approval and issue state', () => {
    assert.ok(header.split('\n')[0].includes('trust this over anything said in comments'));
    assert.ok(header.includes('a0000002 REJECTED'));
    assert.ok(header.includes('a0000006 APPROVED'));
    assert.ok(header.includes('Pending among these: none'));
    assert.ok(header.includes('Parent TOUR-540: cancelled'));
    assert.ok(header.includes('Blocked by TOUR-468: blocked'));
    assert.match(header, /Board decisions since your last activity here \(Oct 7 21:04Z\): 9\b/);
    assert.ok(header.includes('assignee: you (Cyber)'));
    assert.ok(!header.includes('a00000ff'), 'a hex token that is not an approval is not listed');
    assert.equal(stats.approvalsListed.length, 10);
  });

  it('WC3: the CTO 21:06Z comment is condensed (<= 420 + label); the CEO 07:38Z comment is not', () => {
    const cto = commentLine('Oct 7 21:06Z', 'CTO')!;
    assert.ok(cto.startsWith('- [Oct 7 21:06Z] CTO (condensed)'));
    const text = cto.replace(/^- \[[^\]]+\] \S+( \(condensed\))?( \[as of [^\]]+\])?: /, '').replace(/ ⟨now [^⟩]+⟩/g, '');
    assert.ok(text.length <= WAKE_P2_COMMENT_CAP, String(text.length));
    const ceo = commentLine('07:38Z', 'CEO')!;
    assert.ok(ceo.startsWith('- [07:38Z] CEO: '), ceo.slice(0, 40));
    assert.ok(!ceo.includes('[as of'), 'newest comment carries no as-of tag');
    assert.equal(stats.hidden, 2, 'two "Checked out issue" notices hidden');
  });

  it('WC4: the 21:04:42Z Cyber comment is a dedupe marker; the shared ruling text appears once', () => {
    assert.ok(message.includes('- [Oct 7 21:04Z] Cyber: (near-duplicate of the newer Cyber 21:04:54Z comment, omitted)'));
    assert.equal(stats.deduped, 1);
    assert.equal(message.split('Board ruling 8 Oct: descope on evidence').length - 1, 1);
  });

  it('WC5: stale "pending" claims are annotated inline; none is left unflagged', () => {
    assert.ok(message.includes('a0000003 ⟨now APPROVED 07:35Z⟩ (still pending'));
    assert.ok(message.includes('a000000a ⟨now APPROVED 07:35Z⟩ (TOUR-543 A/B, still pending)'));
    assert.ok(message.includes('a0000002 ⟨now REJECTED 07:35Z⟩'));
    assert.equal(stats.annotated, (message.match(/⟨now (APPROVED|REJECTED)/g) ?? []).length);
    assert.ok(stats.annotated >= 11, String(stats.annotated));
    // No decided approval id within 25 chars before / 60 after "pending" is left without ⟨now …⟩.
    const decided = new Set(fx.approvals.filter((a) => a.status !== 'pending').map((a) => a.id.slice(0, 8)));
    const comments = message.slice(message.indexOf('RECENT COMMENTS'));
    for (const m of comments.matchAll(/(?<![0-9A-Za-z_])([0-9a-f]{8})(?![0-9A-Za-z_])/g)) {
      if (!decided.has(m[1])) continue;
      const end = (m.index ?? 0) + m[0].length;
      const near = comments.slice(Math.max(0, (m.index ?? 0) - 25), m.index) + comments.slice(end, end + 60);
      if (/pending/i.test(near)) assert.ok(comments.slice(end).startsWith(' ⟨now '), `unflagged stale claim at ${comments.slice(m.index, end + 40)}`);
    }
    // Annotation never changes the comment's own words.
    const ceo = commentLine('07:38Z', 'CEO')!;
    assert.ok(ceo.replace(/ ⟨now [^⟩]+⟩/g, '').includes('Dependent issues close as accepted-UNVERIFIED via a0000003 (still pending — do not re-file'));
  });

  it('WC6: stats match the rendered sections', () => {
    assert.equal(stats.mode, 'v2');
    assert.equal(stats.headerChars, header.length);
    assert.ok(stats.headerChars <= 2400);
    assert.ok(stats.commentChars <= 4500);
    assert.equal(stats.totalChars, message.length);
    assert.equal(stats.considered, 10);
    assert.equal(stats.shown + stats.hidden + stats.dropped, 10);
  });

  it('deterministic across runs', () => {
    const again = buildWakeMessageWithStats(tour531Job(loadTour531Fixture()), { context: tour531Context(loadTour531Fixture()) });
    assert.equal(again.message, message);
    assert.deepEqual(again.stats, stats);
  });
});
