/** UI-2: pure sidebar model — grouping, status, search, ordering, unread, initial thread, paths. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_THREAD_METADATA_KEYS,
  agentChatStatus,
  assistantAgentPath,
  filterThreadsByTitle,
  groupSidebarAgents,
  isThreadUnread,
  pickInitialThread,
  recentThreads,
  sortAssistantThreads,
  type AssistantAgent,
  type AssistantThread,
} from './sidebar';

const agent = (id: string, name: string, role: string, reportsToId: string | null = null): AssistantAgent => ({
  id,
  name,
  role,
  title: role,
  urlKey: id,
  icon: null,
  reportsToId,
  active: true,
  status: 'idle',
  pendingApprovals: 0,
});

const thread = (id: string, at: string | null, extra: Partial<AssistantThread> = {}): AssistantThread => ({
  id,
  agentId: 'a1',
  title: id,
  pinned: false,
  unread: false,
  lastActivityAt: at,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('UI-2 agentChatStatus', () => {
  it('waiting on you beats running; idle otherwise', () => {
    assert.equal(agentChatStatus({ running: false, pendingApprovals: 0 }), 'idle');
    assert.equal(agentChatStatus({ running: true, pendingApprovals: 0 }), 'running');
    assert.equal(agentChatStatus({ running: true, pendingApprovals: 2 }), 'waiting');
    assert.equal(agentChatStatus({ running: false, pendingApprovals: 1 }), 'waiting');
  });
});

describe('UI-2 groupSidebarAgents', () => {
  const ceo = agent('ceo', 'Ceo', 'ceo');
  const cto = agent('cto', 'Cto', 'cto', 'ceo');
  const eng2 = agent('eng2', 'zed', 'engineer', 'cto');
  const eng1 = agent('eng1', 'Amy', 'engineer', 'cto');
  const qa = agent('qa', 'Quinn', 'qa', 'cto');
  const orphan = agent('orph', 'Orphan', 'pm', 'gone-manager');
  const all = [eng2, qa, ceo, cto, eng1, orphan];

  it('board-level agents are "My agents"; others are teams by role, sorted', () => {
    const s = groupSidebarAgents(all);
    assert.deepEqual(s.pinned, []);
    assert.deepEqual(s.myAgents.map((a) => a.id), ['ceo', 'orph']);
    assert.deepEqual(
      s.teams.map((t) => [t.role, t.agents.map((a) => a.id)]),
      [
        ['cto', ['cto']],
        ['engineer', ['eng1', 'eng2']],
        ['qa', ['qa']],
      ],
    );
  });

  it('pinned agents keep pin order, show once, unknown pins ignored', () => {
    const s = groupSidebarAgents(all, { pinnedAgentIds: ['qa', 'missing', 'ceo', 'qa'] });
    assert.deepEqual(s.pinned.map((a) => a.id), ['qa', 'ceo']);
    const everywhere = [...s.pinned, ...s.myAgents, ...s.teams.flatMap((t) => t.agents)].map((a) => a.id).sort();
    assert.deepEqual(everywhere, all.map((a) => a.id).sort());
    assert.ok(!s.teams.some((t) => t.role === 'qa'));
  });

  it('empty list gives empty sections', () => {
    assert.deepEqual(groupSidebarAgents([]), { pinned: [], myAgents: [], teams: [] });
  });
});

describe('UI-2 thread helpers', () => {
  const t1 = thread('Weekly plan', '2026-02-03T00:00:00.000Z');
  const t2 = thread('Budget review', '2026-02-05T00:00:00.000Z');
  const t3 = thread('Plan B', null, { createdAt: '2026-02-04T00:00:00.000Z' });
  const pinnedOld = thread('Old pinned', '2026-01-01T00:00:00.000Z', { pinned: true });

  it('search is case-insensitive, all terms must match, blank returns all', () => {
    assert.deepEqual(filterThreadsByTitle([t1, t2, t3], 'PLAN').map((t) => t.id), ['Weekly plan', 'Plan B']);
    assert.deepEqual(filterThreadsByTitle([t1, t2, t3], 'plan  weekly').map((t) => t.id), ['Weekly plan']);
    assert.deepEqual(filterThreadsByTitle([t1, t2, t3], '   ').length, 3);
    assert.deepEqual(filterThreadsByTitle([t1, t2, t3], null).length, 3);
    assert.deepEqual(filterThreadsByTitle([t1, t2], 'nothing'), []);
  });

  it('sort: pinned first, then latest activity (creation time when no messages)', () => {
    assert.deepEqual(sortAssistantThreads([t1, t2, pinnedOld, t3]).map((t) => t.id), [
      'Old pinned',
      'Budget review',
      'Plan B',
      'Weekly plan',
    ]);
  });

  it('recent threads ignore pins and honour the limit', () => {
    assert.deepEqual(recentThreads([pinnedOld, t1, t2, t3], 2).map((t) => t.id), ['Budget review', 'Plan B']);
  });

  it('initial thread is the latest own thread, or null for a new one', () => {
    const shared = thread('shared', '2026-03-01T00:00:00.000Z', { agentId: null });
    assert.equal(pickInitialThread([t1, t2, shared, pinnedOld], 'a1')?.id, 'Budget review');
    assert.equal(pickInitialThread([shared], 'a1'), null);
    assert.equal(pickInitialThread([], 'a1'), null);
  });

  it('unread only when the newest message is from the agent and not yet read', () => {
    assert.equal(isThreadUnread({ lastMessageId: 'm2', lastMessageRole: 'assistant', readMessageId: undefined }), true);
    assert.equal(isThreadUnread({ lastMessageId: 'm2', lastMessageRole: 'assistant', readMessageId: 'm1' }), true);
    assert.equal(isThreadUnread({ lastMessageId: 'm2', lastMessageRole: 'assistant', readMessageId: 'm2' }), false);
    assert.equal(isThreadUnread({ lastMessageId: 'm3', lastMessageRole: 'user', readMessageId: 'm1' }), false);
    assert.equal(isThreadUnread({ lastMessageId: null, lastMessageRole: null, readMessageId: null }), false);
  });

  it('paths encode the agent key and thread id', () => {
    assert.equal(assistantAgentPath('cto'), '/assistant/cto');
    assert.equal(assistantAgentPath('cto', 'thr 1/x'), '/assistant/cto/thr%201%2Fx');
    assert.equal(assistantAgentPath('cto', null), '/assistant/cto');
  });

  it('assistant metadata keys are declared for the chat tag filter', () => {
    assert.deepEqual([...ASSISTANT_THREAD_METADATA_KEYS], ['assistantReadMessageId', 'assistantModel']);
  });
});
