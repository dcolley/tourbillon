/**
 * ACT-1: the pure activity view model (names, links, actors, change in words, excerpts, grouping,
 * filters). No database. All ids and names are fakes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityLogEntry } from '@tourbillon/db';
import {
  buildActivityView,
  collectActivityRefs,
  emptyActivityLookup,
  excerptText,
  groupActivityViews,
  hasActiveFilters,
  linkFor,
  parseActivityFilters,
  absoluteTimestamp,
  COMMENT_EXCERPT_CHARS,
  type ActivityLookup,
} from './activity-view';

const ISSUE = '11111111-1111-4111-8111-111111111111';
const OTHER_ISSUE = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const APPROVAL = '55555555-5555-4555-8555-555555555555';
const GOAL = '66666666-6666-4666-8666-666666666666';
const PROJECT = '77777777-7777-4777-8777-777777777777';

function lookup(): ActivityLookup {
  const l = emptyActivityLookup();
  l.issues.set(ISSUE, { identifier: 'TST-1', title: 'Fix the build' });
  l.agents.set(AGENT, { name: 'CEO', urlKey: 'ceo' });
  l.runs.set(RUN, { agentId: AGENT });
  l.approvals.set(APPROVAL, { title: 'Ship it?', status: 'approved' });
  l.goals.set(GOAL, { title: 'Grow' });
  l.projects.set(PROJECT, { title: 'Launch' });
  return l;
}

let n = 0;
function row(over: Partial<ActivityLogEntry>): ActivityLogEntry {
  n += 1;
  return {
    id: `row-${n}`,
    companyId: 'company-a',
    actorType: 'system',
    actorId: 'system',
    actorName: null,
    action: 'issue.updated',
    entityType: 'issue',
    entityId: ISSUE,
    details: {},
    correlationId: null,
    createdAt: new Date('2026-10-24T12:00:00.000Z'),
    ...over,
  } as ActivityLogEntry;
}

describe('ACT-1 activity view: item links', () => {
  it('names and links every item kind, never a bare id label', () => {
    const l = lookup();
    assert.deepEqual(linkFor('issue', ISSUE, l), { kind: 'issue', id: ISSUE, label: 'TST-1 Fix the build', href: `/issue/${ISSUE}` });
    assert.equal(linkFor('agent', AGENT, l).href, '/agent/ceo');
    assert.equal(linkFor('agent', AGENT, l).label, 'CEO');
    assert.equal(linkFor('run', RUN, l).label, 'run 44444444');
    assert.equal(linkFor('run', RUN, l).href, `/heartbeat/${RUN}`);
    assert.equal(linkFor('approval', APPROVAL, l).href, `/approval/${APPROVAL}`);
    assert.equal(linkFor('approval', APPROVAL, l).label, 'Ship it?');
    assert.equal(linkFor('goal', GOAL, l).href, `/goal/${GOAL}`);
    assert.equal(linkFor('project', PROJECT, l).href, `/project/${PROJECT}`);
  });

  it('an id outside the company lookup is "Unknown <kind>" with no link', () => {
    const link = linkFor('issue', OTHER_ISSUE, lookup());
    assert.equal(link.label, 'Unknown issue');
    assert.equal(link.href, null);
    assert.equal(link.id, OTHER_ISSUE, 'id kept for hover / copy only');
  });

  it('collects ids from entity, actor, details, changes and issue lists', () => {
    const refs = collectActivityRefs([
      row({
        actorType: 'agent',
        actorId: AGENT,
        details: { runId: RUN, approvalId: APPROVAL, changes: { goalId: { from: null, to: GOAL } }, issueIds: [OTHER_ISSUE] },
      }),
    ]);
    assert.ok(refs.issue.has(ISSUE) && refs.issue.has(OTHER_ISSUE));
    assert.ok(refs.agent.has(AGENT));
    assert.ok(refs.run.has(RUN));
    assert.ok(refs.approval.has(APPROVAL));
    assert.ok(refs.goal.has(GOAL));
  });
});

describe('ACT-1 activity view: actors', () => {
  it('agent with run: "Agent CEO", run link', () => {
    const view = buildActivityView(row({ actorType: 'agent', actorId: AGENT, details: { runId: RUN } }), lookup());
    assert.equal(view.actor.label, 'Agent CEO');
    assert.equal(view.actor.href, '/agent/ceo');
    assert.equal(view.actor.run?.label, 'run 44444444');
  });

  it('a run id that is not a heartbeat run of the company gets no run link', () => {
    const view = buildActivityView(row({ actorType: 'agent', actorId: AGENT, details: { runId: 'chat-session-x' } }), lookup());
    assert.equal(view.actor.run, null);
  });

  it('system row from a decision: via approval <title>, outcome and decider', () => {
    const view = buildActivityView(
      row({ actorId: 'board', actorName: 'Board', details: { approvalId: APPROVAL, decision: 'approved', status: 'todo' } }),
      lookup(),
    );
    assert.equal(view.actor.label, 'System');
    assert.equal(view.actor.viaApproval?.label, 'Ship it?');
    assert.equal(view.actor.viaApproval?.href, `/approval/${APPROVAL}`);
    assert.equal(view.actor.viaOutcome, 'approved');
    assert.equal(view.actor.viaDecider, 'Board');
  });

  it('board user decision row and HITLy hand-off row', () => {
    const decided = buildActivityView(
      row({
        actorType: 'user',
        actorId: 'board',
        actorName: 'Board',
        action: 'approval.decided',
        entityType: 'approval',
        entityId: APPROVAL,
        details: { status: 'rejected', decision: 'rejected', reason: 'Not now', changes: { status: { from: 'pending', to: 'rejected' } } },
      }),
      lookup(),
    );
    assert.equal(decided.actor.label, 'Board');
    assert.equal(decided.item?.label, 'Ship it?');
    assert.deepEqual(decided.decision, { outcome: 'rejected', reason: 'Not now', answer: null });
    assert.deepEqual(decided.changes[0], { field: 'status', label: 'Status', from: { text: 'pending' }, to: { text: 'rejected' } });

    const handOff = buildActivityView(
      row({ actorId: 'hitly-forward', actorName: 'HITLy hand-off', action: 'approval.forwarded', entityType: 'approval', entityId: APPROVAL }),
      lookup(),
    );
    assert.equal(handOff.actor.label, 'System (HITLy hand-off)');
    assert.equal(handOff.actionLabel, 'Approval sent to HITLy');
  });
});

describe('ACT-1 activity view: change in words', () => {
  it('recorded changes: from → to, ids become named links', () => {
    const view = buildActivityView(
      row({
        details: {
          changes: {
            status: { from: 'in_progress', to: 'blocked' },
            assigneeAgentId: { from: null, to: AGENT },
            boardApprovalId: { from: null, to: APPROVAL },
          },
        },
      }),
      lookup(),
    );
    assert.deepEqual(view.changes[0], { field: 'status', label: 'Status', from: { text: 'in progress' }, to: { text: 'blocked' } });
    assert.deepEqual(view.changes[1].from, { text: 'nobody' });
    assert.deepEqual(view.changes[1].to, { link: { kind: 'agent', id: AGENT, label: 'CEO', href: '/agent/ceo' } });
    assert.equal((view.changes[2].to as { link: { label: string } }).link.label, 'Ship it?');
  });

  it('legacy issue.updated rows still render from their keys', () => {
    const view = buildActivityView(row({ details: { status: 'done', previousStatus: 'todo', priority: 'high' } }), lookup());
    assert.deepEqual(
      view.changes.map((c) => [c.field, c.from, c.to]),
      [
        ['status', { text: 'todo' }, { text: 'done' }],
        ['priority', null, { text: 'high' }],
      ],
    );
  });

  it('other actions do not invent changes from their details', () => {
    const view = buildActivityView(row({ action: 'issue.checked_out', details: { status: 'in_progress' } }), lookup());
    assert.deepEqual(view.changes, []);
  });
});

describe('ACT-1 activity view: comment excerpt', () => {
  it('short comments are shown whole', () => {
    assert.deepEqual(excerptText('  hello  '), { excerpt: 'hello', full: 'hello', truncated: false });
  });

  it('long comments are cut near 140 characters and keep the full text', () => {
    const text = 'word '.repeat(60).trim();
    const c = excerptText(text);
    assert.equal(c.truncated, true);
    assert.equal(c.full, text);
    assert.ok(c.excerpt.endsWith('…'));
    assert.ok(c.excerpt.length <= COMMENT_EXCERPT_CHARS + 1);
    const view = buildActivityView(row({ action: 'issue.commented', details: { body: text, comment: text } }), lookup());
    assert.equal(view.comment?.truncated, true);
  });
});

describe('ACT-1 activity view: correlation groups', () => {
  it('rows sharing a correlation id group where the newest row is', () => {
    const l = lookup();
    const views = [
      row({ correlationId: 'c1' }),
      row({}),
      row({ correlationId: 'c1' }),
      row({ correlationId: 'c2' }),
    ].map((r) => buildActivityView(r, l));
    const groups = groupActivityViews(views);
    assert.deepEqual(
      groups.map((g) => [g.correlationId, g.rows.length]),
      [
        ['c1', 2],
        [null, 1],
        ['c2', 1],
      ],
    );
  });
});

describe('ACT-1 activity view: filters', () => {
  it('parses type, actor, UTC date range and correlation', () => {
    const f = parseActivityFilters({ type: 'approval', actor: `agent:${AGENT}`, from: '2026-10-01', to: '2026-10-24', correlation: 'abc-1' });
    assert.equal(f.entityType, 'approval');
    assert.deepEqual(f.actor, { type: 'agent', id: AGENT });
    assert.equal(f.from?.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(f.toExclusive?.toISOString(), '2026-10-25T00:00:00.000Z');
    assert.equal(f.correlationId, 'abc-1');
    assert.equal(hasActiveFilters(f), true);
  });

  it('ignores malformed values', () => {
    const f = parseActivityFilters({ type: 'nope', actor: "agent:x' or 1=1", from: '2026-02-30', to: 'yesterday', correlation: 'a b' });
    assert.equal(f.entityType, null);
    assert.equal(f.actor, null);
    assert.equal(f.from, null);
    assert.equal(f.toExclusive, null);
    assert.equal(f.correlationId, null);
    assert.equal(hasActiveFilters(f), false);
    assert.deepEqual(f.raw, { type: '', actor: '', from: '', to: '', correlation: '' });
  });

  it('absolute timestamp for hover', () => {
    assert.equal(absoluteTimestamp(new Date('2026-10-24T20:32:05.123Z')), '2026-10-24 20:32:05 UTC');
  });
});
