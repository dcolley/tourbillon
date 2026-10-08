import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWakeMessage, buildWakeMessageWithStats } from './wake-message';
import type { HeartbeatJobData, WakePayload } from './types';
import { WAKE_P1_COMMENT_CAP } from './wake-context/constants';
import type { WakeLiveContext } from './wake-context/types';

const t = (i: number) => new Date(Date.UTC(2026, 9, 7, 10, i)).toISOString();
const body = (i: number, len: number) => `#${i}# ${'lorem ipsum dolor '.repeat(Math.ceil(len / 18))}`.slice(0, len);

function job(comments: WakePayload['newComments'], over: Partial<HeartbeatJobData> = {}): HeartbeatJobData {
  const payload: WakePayload = {
    issue: { id: 'task-1', identifier: 'TOUR-1', title: 'Fix', status: 'in_progress', priority: 'high', assigneeAgentId: 'agent-1' },
    newComments: comments,
    fallbackFetchNeeded: false,
  };
  return {
    agentId: 'agent-1', companyId: 'co-1', invocationSource: 'assignment', wakeReason: 'assignment', taskId: 'task-1',
    wakePayloadJson: JSON.stringify(payload), ...over,
  };
}
const ten = Array.from({ length: 10 }, (_, i) => ({
  id: `c${i + 1}`, body: body(i + 1, 1000), authorType: 'agent' as const, authorName: 'Bot', createdAt: t(i + 1),
}));
const ctx: WakeLiveContext = {
  version: 1, asOf: '2026-10-07T12:00:00.000Z', agent: { id: 'agent-1', name: 'Cyber', urlKey: 'cyber' },
  task: { id: 'task-1', identifier: 'TOUR-1', title: 'Fix', status: 'in_review', priority: 'high', assignee: { kind: 'self', name: 'Cyber' } },
  parent: null, blockers: [], approvals: [], referencedIssues: [], lastActivityAt: null, userCommentsSinceLastActivity: 0,
};

describe('WC1 newest-first fill, chronological display', () => {
  for (const mode of ['t1', 'v2'] as const) {
    const opts = mode === 'v2' ? { context: ctx } : {};

    it(`[${mode}] keeps newest when over budget: #10 present, #1 absent, display ascending`, () => {
      const { message, stats } = buildWakeMessageWithStats(job(ten), opts);
      assert.equal(stats.mode, mode);
      assert.ok(message.includes('#10#'));
      assert.ok(!message.includes('#1# '));
      const order = [...message.matchAll(/#(\d+)#/g)].map((m) => Number(m[1]));
      assert.ok(order.length >= 2 && order.length < 10, String(order));
      assert.deepEqual(order, [...order].sort((a, b) => a - b));
      assert.equal(order[order.length - 1], 10);
      assert.ok(stats.dropped > 0);
    });

    it(`[${mode}] always includes the newest even if larger than the budget, cut to the P1 cap with …`, () => {
      const comments = [...ten.slice(0, 3), { ...ten[3], id: 'big', body: `#99# ${'x'.repeat(5000)}`, createdAt: t(30) }];
      const { message } = buildWakeMessageWithStats(job(comments), opts);
      const line = message.split('\n').find((l) => l.includes('#99#'))!;
      assert.ok(line, 'newest present');
      const text = line.slice(line.indexOf('#99#'));
      assert.ok(text.length <= WAKE_P1_COMMENT_CAP, String(text.length));
      assert.ok(text.endsWith('…'));
    });

    it(`[${mode}] heading states "last N: S shown, H hidden, D dropped for space"; hint present when dropped`, () => {
      const { message, stats } = buildWakeMessageWithStats(job(ten), opts);
      assert.match(message, new RegExp(`last 10: ${stats.shown} shown, ${stats.hidden} hidden, ${stats.dropped} dropped for space`));
      assert.ok(message.includes('call getComments without `after` for the full thread'));
    });
  }

  it('[t1] no hint when nothing dropped and fallbackFetchNeeded is false; hint when fallbackFetchNeeded', () => {
    const small = ten.slice(0, 2).map((c) => ({ ...c, body: 'short' }));
    assert.ok(!buildWakeMessage(job(small)).includes('getComments'));
    const j = job(small);
    const p = JSON.parse(j.wakePayloadJson!) as WakePayload;
    p.fallbackFetchNeeded = true;
    assert.ok(buildWakeMessage({ ...j, wakePayloadJson: JSON.stringify(p) }).includes('getComments without `after`'));
  });

  it('[t1] keeps the existing layout (Task line, ISO timestamps, heartbeat line)', () => {
    const m = buildWakeMessage(job(ten.slice(0, 1).map((c) => ({ ...c, body: 'hello' }))));
    assert.ok(m.startsWith('Wake reason: assignment\nAssigned task ID: task-1\nTask: TOUR-1 — Fix (in_progress, high)'));
    assert.ok(m.includes(`- [${t(1)}] Bot: hello`));
    assert.ok(m.endsWith('Begin your heartbeat procedure. Follow SKILL: Control Plane Operations exactly.'));
  });
});

describe('wake message modes', () => {
  it('approval_resolved: LIVE STATE header comes after the Board note', () => {
    const m = buildWakeMessage(
      job(ten.slice(0, 2), { wakeReason: 'approval_resolved', approvalId: 'appr-1', approvalStatus: 'approved', approvalNote: 'Go ahead.' }),
      { context: ctx },
    );
    assert.ok(m.indexOf('Board note: Go ahead.') < m.indexOf('LIVE STATE'));
    assert.ok(m.indexOf('LIVE STATE') < m.indexOf('RECENT COMMENTS'));
  });

  it('agent_mail ignores the context and is unchanged (no heartbeat line)', () => {
    const data: HeartbeatJobData = {
      agentId: 'a', companyId: 'c', invocationSource: 'agent_mail', wakeReason: 'agent_mail', mailId: 'm1', mailFromAgentName: 'CEO', mailBody: ' hi ',
    };
    assert.equal(buildWakeMessage(data, { context: ctx }), 'Wake reason: agent_mail\nMail ID: m1\nFrom: CEO\nMessage: hi');
  });

  it('a wake without a task is T1 even with a context', () => {
    const r = buildWakeMessageWithStats({ ...job(ten), taskId: undefined }, { context: ctx });
    assert.equal(r.stats.mode, 't1');
  });

  it('malformed payload JSON is ignored', () => {
    const m = buildWakeMessage({ ...job([]), wakePayloadJson: '{nope' });
    assert.ok(m.startsWith('Wake reason: assignment'));
    const v2 = buildWakeMessage({ ...job([]), wakePayloadJson: '{nope' }, { context: ctx });
    assert.ok(v2.includes('LIVE STATE') && v2.includes('RECENT COMMENTS: none in this wake.'));
  });

  it('is deterministic: same input, same output (both modes)', () => {
    for (const opts of [{}, { context: ctx }]) {
      const a = buildWakeMessageWithStats(job(ten), opts);
      const b = buildWakeMessageWithStats(JSON.parse(JSON.stringify(job(ten))), JSON.parse(JSON.stringify(opts)));
      assert.equal(a.message, b.message);
      assert.deepEqual(a.stats, b.stats);
    }
  });
});
