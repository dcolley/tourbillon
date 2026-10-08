import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWakeMessageWithStats } from '../wake-message';
import { renderCommentSectionV2 } from './comments';
import { WAKE_COMMENTS_MAX_CHARS, WAKE_HEADER_MAX_CHARS, WAKE_P2_COMMENT_CAP, WAKE_TOTAL_SOFT_MAX_CHARS } from './constants';
import type { HeartbeatJobData } from '../types';
import type { WakeApprovalRef, WakeLiveContext } from './types';

const t = (i: number) => new Date(Date.UTC(2026, 9, 7, 0, 0, i * 60)).toISOString();
const para = (i: number) =>
  Array.from({ length: 12 }, (_, l) => `Line ${l} of comment ${i}: approval a${String(i % 9).padStart(7, '0')} still pending; TOUR-${400 + l} blocked; ${'filler '.repeat(20)}`).join('\n');

function bigContext(): WakeLiveContext {
  const approvals: WakeApprovalRef[] = Array.from({ length: 9 }, (_, i) => ({
    id: `a${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, status: i % 2 ? 'approved' : 'rejected',
    decidedAt: '2026-10-08T07:35:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', note: 'Long Board note text. '.repeat(20), linked: true,
  }));
  return {
    version: 1, asOf: '2026-10-08T07:38:00.000Z', agent: { id: 'agent-1', name: 'Cyber', urlKey: 'cyber' },
    task: { id: 'task-1', identifier: 'TOUR-1', title: 'Big thread', status: 'blocked', priority: 'high', assignee: { kind: 'self', name: 'Cyber' } },
    parent: { identifier: 'TOUR-2', status: 'done' },
    blockers: Array.from({ length: 12 }, (_, i) => ({ identifier: `TOUR-${50 + i}`, status: 'blocked' })),
    approvals,
    referencedIssues: Array.from({ length: 12 }, (_, i) => ({ identifier: `TOUR-${400 + i}`, status: 'in_progress' })),
    lastActivityAt: '2026-10-07T00:00:00.000Z', userCommentsSinceLastActivity: 3,
  };
}

function bigJob(n: number): HeartbeatJobData {
  const newComments = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, body: para(i), authorType: (i % 7 === 0 ? 'user' : 'agent') as 'user' | 'agent', authorName: i % 7 === 0 ? 'Board' : `Agent${i % 3}`, createdAt: t(i),
  }));
  return {
    agentId: 'agent-1', companyId: 'co', invocationSource: 'assignment', wakeReason: 'assignment', taskId: 'task-1',
    wakePayloadJson: JSON.stringify({ issue: { id: 'task-1', identifier: 'TOUR-1', title: 'Big thread', status: 'blocked', priority: 'high', assigneeAgentId: 'agent-1' }, newComments, fallbackFetchNeeded: true }),
  };
}

const commentSection = (m: string) => m.slice(m.indexOf('RECENT COMMENTS'), m.indexOf('\n\nThis is a compressed view'));
const headerSection = (m: string) => m.slice(m.indexOf('LIVE STATE'), m.indexOf('\n\nRECENT COMMENTS'));

describe('WC6 section budgets', () => {
  it('30 large comments: comments <= 4,500, header <= 2,400, total <= 7,500', () => {
    const { message, stats } = buildWakeMessageWithStats(bigJob(30), { context: bigContext() });
    assert.ok(commentSection(message).length <= WAKE_COMMENTS_MAX_CHARS, String(commentSection(message).length));
    assert.equal(stats.commentChars, commentSection(message).length);
    assert.ok(headerSection(message).length <= WAKE_HEADER_MAX_CHARS);
    assert.equal(stats.headerChars, headerSection(message).length);
    assert.ok(message.length <= WAKE_TOTAL_SOFT_MAX_CHARS, String(message.length));
    assert.equal(stats.totalChars, message.length);
    assert.equal(stats.considered, 30);
    assert.equal(stats.shown + stats.hidden + stats.dropped, 30);
    assert.ok(stats.dropped > 0);
    assert.ok(message.includes('comment 29:'), 'newest comment present');
  });

  it('per-company budgets are honoured (smaller header/comments/total)', () => {
    const budgets = { headerMaxChars: 900, commentsMaxChars: 1500, totalSoftMaxChars: 3000 };
    const { message, stats } = buildWakeMessageWithStats(bigJob(30), { context: bigContext(), budgets });
    assert.ok(stats.headerChars <= 900, String(stats.headerChars));
    assert.ok(stats.commentChars <= 1500, String(stats.commentChars));
    assert.ok(message.length <= 3000, String(message.length));
  });

  it('total cap squeezes the comment budget below its own max', () => {
    const budgets = { headerMaxChars: 2400, commentsMaxChars: 4500, totalSoftMaxChars: 4000 };
    const { message, stats } = buildWakeMessageWithStats(bigJob(30), { context: bigContext(), budgets });
    assert.ok(message.length <= 4000, String(message.length));
    assert.ok(stats.commentChars < 4500);
  });

  it('comment budget edge: a section that exactly fits is kept whole; one char less drops a comment', () => {
    const comments = Array.from({ length: 3 }, (_, i) => ({ body: `plain note ${i} ${'w '.repeat(50)}`, authorType: 'agent', authorName: 'A', createdAt: t(i) }));
    const full = renderCommentSectionV2(comments, { budget: 100_000, approvals: new Map() });
    // Budget reserves the widest heading ("last 3: 3 shown, 3 hidden, 3 dropped") which equals the real one here.
    const exact = renderCommentSectionV2(comments, { budget: full.text.length, approvals: new Map() });
    assert.equal(exact.shown, 3);
    assert.equal(exact.text, full.text);
    const short = renderCommentSectionV2(comments, { budget: full.text.length - 1, approvals: new Map() });
    assert.equal(short.shown, 2);
    assert.equal(short.dropped, 1);
    assert.ok(short.text.length <= full.text.length - 1);
  });
});

describe('WC3 priority caps under budget pressure', () => {
  const c = (i: number, over: Record<string, unknown> = {}) => ({
    body: `comment ${i}\n${'detail '.repeat(300)}\nlast line ${i}`, authorType: 'agent', authorName: 'Peer', createdAt: t(i), ...over,
  });

  it('P2 comments are capped at 420 chars of text and labelled (condensed); P1 up to 1,200', () => {
    const s = renderCommentSectionV2([c(1), c(2, { body: `Board answered: APPROVED\n${'detail '.repeat(300)}\nend` }), c(3)], {
      budget: 10_000, approvals: new Map(),
    });
    const lines = s.text.split('\n').slice(1);
    const text = (l: string) => l.replace(/^- \[[^\]]+\] \S+( \(condensed\))?( \[as of [^\]]+\])?: /, '');
    assert.ok(lines[0].includes('(condensed)'));
    assert.ok(text(lines[0]).length <= WAKE_P2_COMMENT_CAP);
    assert.ok(!lines[1].includes('(condensed)'));
    assert.ok(text(lines[1]).length > WAKE_P2_COMMENT_CAP && text(lines[1]).length <= 1200);
    assert.ok(!lines[2].includes('(condensed)'), 'newest is P1');
  });

  it('P1 is never skipped in favour of an older P2: P1s are placed (shrunk if needed) before any P2', () => {
    const comments = [
      c(1), c(2), c(3),
      c(4, { authorType: 'user', authorName: 'Board' }),
      c(5), c(6),
      c(7, { body: `Board ruling\n${'detail '.repeat(300)}\nend` }),
      c(8),
    ];
    // Room for the three P1s (the oldest one shrunk) but not for the newer P2s at indexes 4 and 5.
    const s = renderCommentSectionV2(comments, { budget: 3400, approvals: new Map() });
    assert.deepEqual(s.shownIndexes, [3, 6, 7]);
    assert.ok(s.text.length <= 3400);
    const userLine = s.text.split('\n').find((l) => l.includes('] Board: '))!;
    assert.ok(userLine.length < 1200 && userLine.includes('comment 4'), 'older P1 shrunk into the room left');
    // With room for everything, P2s come back.
    assert.ok(renderCommentSectionV2(comments, { budget: 20_000, approvals: new Map() }).shownIndexes.length === 8);
  });

  it('hidden "Checked out issue" notices are counted, not shown', () => {
    const s = renderCommentSectionV2(
      [c(1), { body: '⏳ Checked out issue.', authorType: 'agent', authorName: 'Peer', createdAt: t(2) }, c(3)],
      { budget: 10_000, approvals: new Map() },
    );
    assert.equal(s.hidden, 1);
    assert.ok(!s.text.includes('Checked out issue'));
    assert.match(s.text, /last 3: 2 shown, 1 hidden, 0 dropped for space/);
  });
});
