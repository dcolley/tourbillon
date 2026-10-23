/**
 * UI-2b: assistant sidebar store against a scripted UI-2 API: loading (agents, then every agent's
 * threads), selection (latest thread or a new one), rename, pin / unpin with the cap, unread,
 * search across agents, and the error states.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantApiError, type AssistantSidebarApi, type AssistantThreadPatch } from './sidebar-api';
import { ASSISTANT_MAX_PINS_PER_AGENT, type AssistantAgent, type AssistantThread } from './sidebar';
import {
  AssistantSidebarStore,
  pinnedCount,
  pinnedThreads,
  recentThreadRefs,
  searchResults,
  selectionProblem,
  sidebarSections,
  validateThreadTitle,
} from './sidebar-store';

const agent = (id: string, extra: Partial<AssistantAgent> = {}): AssistantAgent => ({
  id,
  name: id.toUpperCase(),
  role: 'general',
  title: '',
  urlKey: `${id}-key`,
  icon: null,
  reportsToId: null,
  active: true,
  status: 'idle',
  pendingApprovals: 0,
  ...extra,
});
const thread = (id: string, agentId: string, extra: Partial<AssistantThread> = {}): AssistantThread => ({
  id,
  agentId,
  title: `Thread ${id}`,
  pinned: false,
  unread: false,
  lastActivityAt: '2026-10-01T10:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
  ...extra,
});

interface FakeApiOpts {
  agents?: AssistantAgent[] | Error;
  threads?: Record<string, AssistantThread[] | Error>;
  initial?: Record<string, string | null>;
  create?: (agentKey: string) => AssistantThread | Error;
  update?: (agentKey: string, threadId: string, patch: AssistantThreadPatch) => AssistantThread | Error;
}

function fakeApi(o: FakeApiOpts) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const keyToId = (key: string) => key.replace(/-key$/, '');
  const api: AssistantSidebarApi = {
    listAgents: async () => {
      calls.push('agents');
      if (o.agents instanceof Error) throw o.agents;
      return { companyId: 'company-1', agents: o.agents ?? [] };
    },
    listThreads: async (key) => {
      calls.push(`threads:${key}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const t = o.threads?.[keyToId(key)] ?? [];
      if (t instanceof Error) throw t;
      const initial = o.initial?.[keyToId(key)];
      return { agentId: keyToId(key), threads: t, initialThreadId: initial === undefined ? (t[0]?.id ?? null) : initial };
    },
    createThread: async (key) => {
      calls.push(`create:${key}`);
      const r = o.create?.(key) ?? thread('new-1', keyToId(key), { title: '' });
      if (r instanceof Error) throw r;
      return r;
    },
    updateThread: async (key, id, patch) => {
      calls.push(`update:${key}:${id}:${JSON.stringify(patch)}`);
      const r = o.update?.(key, id, patch);
      if (r instanceof Error) throw r;
      if (r) return r;
      throw new Error('no update handler');
    },
  };
  return { api, calls, get maxInFlight() {
    return maxInFlight;
  } };
}

async function loaded(o: FakeApiOpts, concurrency?: number) {
  const fake = fakeApi(o);
  const store = new AssistantSidebarStore({ api: fake.api, concurrency });
  await store.load();
  return { store, ...fake, fake };
}

const c0 = () => '\u200B\u200B';

describe('UI-2b assistant sidebar store', () => {
  describe('loading', () => {
    it("loads the company's agents, then each agent's threads (bounded parallelism)", async () => {
      const agents = ['a', 'b', 'c', 'd', 'e'].map((id) => agent(id));
      const { store, calls, fake } = await loaded(
        { agents, threads: { a: [thread('a1', 'a')], c: [thread('c1', 'c'), thread('c2', 'c')] } },
        2,
      );
      const s = store.getState();
      assert.equal(s.phase, 'ready');
      assert.equal(s.companyId, 'company-1');
      assert.equal(calls[0], 'agents');
      assert.deepEqual(calls.slice(1).sort(), agents.map((a) => `threads:${a.urlKey}`).sort());
      assert.ok(fake.maxInFlight <= 2, `max in flight ${fake.maxInFlight}`);
      assert.deepEqual(s.threads.c.threads.map((t) => t.id), ['c1', 'c2']);
      assert.equal(s.threads.b.status, 'ready');
      assert.deepEqual(s.threads.b.threads, []);
    });

    it('agent list failure → error phase with the message; retry loads', async () => {
      const o: FakeApiOpts = { agents: new AssistantApiError('No active company selected', 401) };
      const { store } = await loaded(o);
      assert.deepEqual([store.getState().phase, store.getState().loadError], ['error', 'No active company selected']);
      o.agents = [agent('a')];
      await store.load();
      assert.equal(store.getState().phase, 'ready');
      assert.equal(store.getState().loadError, null);
    });

    it("one agent's thread list failing does not block the others; retry reloads it", async () => {
      const o: FakeApiOpts = {
        agents: [agent('a'), agent('b')],
        threads: { a: new AssistantApiError('Internal error', 500), b: [thread('b1', 'b')] },
      };
      const { store } = await loaded(o);
      assert.deepEqual([store.getState().threads.a.status, store.getState().threads.a.error], ['error', 'Internal error']);
      assert.equal(store.getState().threads.b.status, 'ready');
      o.threads!.a = [thread('a1', 'a')];
      await store.loadThreads('a');
      assert.equal(store.getState().threads.a.status, 'ready');
    });

    it('a store disposed mid-load (company switch) never applies the late responses', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fake = fakeApi({ agents: ['a', 'b', 'c', 'd'].map((id) => agent(id)), threads: { a: [thread('a1', 'a')] } });
      const listAgents = fake.api.listAgents;
      fake.api.listAgents = async () => {
        await gate;
        return listAgents();
      };
      const store = new AssistantSidebarStore({ api: fake.api, concurrency: 1 });
      const before = store.getState();
      const p = store.load();
      const loading = store.getState();
      store.dispose();
      release();
      await p;
      assert.notEqual(loading, before);
      assert.equal(store.getState(), loading, 'no state change after dispose');
      assert.deepEqual(store.getState().agents, []);
      assert.equal(fake.calls.filter((c) => c.startsWith('threads:')).length, 0, 'no thread lists requested after dispose');
    });

    it('disposing while thread lists load stops the remaining requests', async () => {
      const fake = fakeApi({ agents: ['a', 'b', 'c', 'd'].map((id) => agent(id)) });
      const store = new AssistantSidebarStore({ api: fake.api, concurrency: 1 });
      const p = store.load();
      await new Promise((r) => setTimeout(r, 1)); // agents loaded, first thread list in flight
      store.dispose();
      await p;
      assert.ok(fake.calls.filter((c) => c.startsWith('threads:')).length <= 1, fake.calls.join());
      assert.ok(!store.getState().threads.b, 'later agents untouched');
    });

    it('reloading drops the previous threads (no stale lists while the new ones load)', async () => {
      const o: FakeApiOpts = { agents: [agent('a'), agent('gone')], threads: { a: [thread('a1', 'a')], gone: [thread('g1', 'gone')] } };
      const fake = fakeApi(o);
      const store = new AssistantSidebarStore({ api: fake.api });
      await store.load();
      o.agents = [agent('a')];
      o.threads = { a: [thread('a2', 'a')] };
      let sawStale = false;
      const off = store.subscribe(() => {
        const s = store.getState();
        if (s.agents.length === 1 && (s.threads.a?.threads.some((t) => t.id === 'a1') || s.threads.gone)) sawStale = true;
      });
      await store.load();
      off();
      assert.equal(sawStale, false);
      assert.deepEqual(Object.keys(store.getState().threads), ['a']);
      assert.deepEqual(store.getState().threads.a.threads.map((t) => t.id), ['a2']);
    });

    it('dispose stops further updates', async () => {
      const fake = fakeApi({ agents: [agent('a')] });
      const store = new AssistantSidebarStore({ api: fake.api });
      let n = 0;
      store.subscribe(() => n++);
      const p = store.load();
      store.dispose();
      await p;
      assert.equal(n, 1, 'only the synchronous loading update');
    });
  });

  describe('sections, recent, pinned and search (across agents)', () => {
    const agents = [
      agent('ceo', { name: 'Chief' }),
      agent('eng1', { name: 'Builder', role: 'engineer', reportsToId: 'ceo' }),
      agent('eng2', { name: 'Archer', role: 'engineer', reportsToId: 'ceo' }),
      agent('des', { name: 'Drawer', role: 'designer', reportsToId: 'ceo' }),
      agent('free', { name: 'Loner', reportsToId: 'not-in-company' }),
    ];
    const threads = {
      ceo: [thread('t1', 'ceo', { title: 'Quarterly plan', pinned: true, lastActivityAt: '2026-10-01T08:00:00Z' })],
      eng1: [
        thread('t2', 'eng1', { title: 'Fix login bug', lastActivityAt: '2026-10-03T08:00:00Z' }),
        thread('t3', 'eng1', { title: 'Plan the migration', lastActivityAt: '2026-10-02T08:00:00Z', pinned: true }),
      ],
    };

    it('agents grouped into My agents and Teams by role (A–Z)', async () => {
      const { store } = await loaded({ agents, threads });
      const s = sidebarSections(store.getState());
      assert.deepEqual(s.myAgents.map((a) => a.id), ['ceo', 'free']);
      assert.deepEqual(s.teams.map((t) => [t.role, t.agents.map((a) => a.name)]), [
        ['designer', ['Drawer']],
        ['engineer', ['Archer', 'Builder']],
      ]);
    });

    it('pinned threads and recent threads span agents, most recent first', async () => {
      const { store } = await loaded({ agents, threads });
      assert.deepEqual(pinnedThreads(store.getState()).map((r) => [r.agent.id, r.thread.id]), [
        ['eng1', 't3'],
        ['ceo', 't1'],
      ]);
      assert.deepEqual(recentThreadRefs(store.getState(), 2).map((r) => r.thread.id), ['t2', 't3']);
    });

    it('search filters thread titles (every term, any case) across agents', async () => {
      const { store } = await loaded({ agents, threads });
      store.setSearch('PLAN');
      assert.deepEqual(searchResults(store.getState()).map((r) => r.thread.id), ['t3', 't1']);
      store.setSearch('plan migration');
      assert.deepEqual(searchResults(store.getState()).map((r) => r.thread.id), ['t3']);
      store.setSearch('nothing like this');
      assert.deepEqual(searchResults(store.getState()), []);
      store.setSearch('   ');
      assert.deepEqual(searchResults(store.getState()), []);
    });
  });

  describe('selecting an agent', () => {
    it('opens its latest thread (initialThreadId from the API)', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [thread('a1', 'a'), thread('a2', 'a')] }, initial: { a: 'a2' } });
      assert.equal(await store.selectAgent('a'), '/assistant?agent=a-key&thread=a2');
      assert.ok(!calls.some((c) => c.startsWith('create')));
    });

    it('with no threads, starts a new one and opens it', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [] } });
      assert.equal(await store.selectAgent('a'), '/assistant?agent=a-key&thread=new-1');
      assert.ok(calls.includes('create:a-key'));
      assert.deepEqual(store.getState().threads.a.threads.map((t) => t.id), ['new-1']);
      assert.equal(store.getState().threads.a.initialThreadId, 'new-1');
      assert.deepEqual(store.getState().pending, {});
    });

    it('thread creation refused (429) → notice with the API message, no navigation', async () => {
      const { store } = await loaded({
        agents: [agent('a')],
        threads: { a: [] },
        create: () => new AssistantApiError('Too many new threads for this company; try again in 30s', 429, 30),
      });
      assert.equal(await store.selectAgent('a'), null);
      assert.deepEqual(store.getState().notice, { message: 'Too many new threads for this company; try again in 30s', agentId: 'a' });
      store.dismissNotice();
      assert.equal(store.getState().notice, null);
    });

    it('threads not loaded yet are loaded first; a failing list → notice', async () => {
      const o: FakeApiOpts = { agents: [agent('a')], threads: { a: new AssistantApiError('Agent not found', 404) } };
      const { store } = await loaded(o);
      assert.equal(await store.selectAgent('a'), null);
      assert.equal(store.getState().notice?.message, 'Agent not found');
      o.threads!.a = [thread('a1', 'a')];
      assert.equal(await store.selectAgent('a'), '/assistant?agent=a-key&thread=a1');
    });

    it('repeated New thread clicks while one is being created send one request', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [] } });
      const [first, second, viaSelect] = await Promise.all([store.newThread('a'), store.newThread('a'), store.selectAgent('a')]);
      assert.equal(first, '/assistant?agent=a-key&thread=new-1');
      assert.equal(second, null);
      assert.equal(viaSelect, null, 'select while creating does not create a second thread');
      assert.equal(calls.filter((c) => c.startsWith('create')).length, 1);
      assert.equal(store.getState().threads.a.threads.length, 1);
    });

    it('new thread button adds a thread and opens it', async () => {
      const { store } = await loaded({ agents: [agent('a')], threads: { a: [thread('a1', 'a')] } });
      assert.equal(await store.newThread('a'), '/assistant?agent=a-key&thread=new-1');
      assert.deepEqual(store.getState().threads.a.threads.map((t) => t.id).sort(), ['a1', 'new-1']);
    });
  });

  describe('rename', () => {
    it('sends the trimmed title and shows the saved thread', async () => {
      const { store, calls } = await loaded({
        agents: [agent('a')],
        threads: { a: [thread('a1', 'a')] },
        update: (_k, id, patch) => thread(id, 'a', { title: patch.title }),
      });
      assert.equal(await store.rename('a', 'a1', '  Roadmap  '), true);
      assert.ok(calls.includes('update:a-key:a1:{"title":"Roadmap"}'));
      assert.equal(store.getState().threads.a.threads[0].title, 'Roadmap');
      assert.deepEqual(store.getState().pending, {});
    });

    it('invalid titles are refused locally (no request)', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [thread('a1', 'a')] } });
      for (const bad of ['   ', 'x'.repeat(201), 'bad\u0007title']) {
        assert.equal(await store.rename('a', 'a1', bad), false);
        assert.ok(store.getState().notice);
      }
      assert.ok(!calls.some((c) => c.startsWith('update')));
      assert.deepEqual(validateThreadTitle(' ok '), { ok: true, title: 'ok' });
    });

    it('bidi controls are refused locally (no request): U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [thread('a1', 'a')] } });
      for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C']) {
        assert.equal(await store.rename('a', 'a1', `abc${c}def`), false, c.codePointAt(0)!.toString(16));
        assert.equal(store.getState().notice?.message, 'Title must not contain bidirectional text controls');
        assert.equal(await store.rename('a', 'a1', `${c}abc`), false, 'at the start too');
      }
      assert.ok(!calls.some((c) => c.startsWith('update')));
      assert.equal(store.getState().threads.a.threads[0].title, 'Thread a1');
    });

    it('zero-width characters are refused locally (no request): U+200B–200D, U+2060, U+FEFF', async () => {
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [thread('a1', 'a')] } });
      for (const c of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
        assert.equal(await store.rename('a', 'a1', `abc${c}def`), false, c.codePointAt(0)!.toString(16));
        assert.equal(store.getState().notice?.message, 'Title must not contain zero-width characters');
        assert.equal(await store.rename('a', 'a1', `abc${c}`), false, 'at the end too (trim would drop U+FEFF)');
      }
      assert.equal(await store.rename('a', 'a1', c0()), false, 'a title of only zero-width characters');
      assert.ok(!calls.some((c) => c.startsWith('update')));
    });

    it('API refusal (archived agent) → notice, title unchanged', async () => {
      const { store } = await loaded({
        agents: [agent('a')],
        threads: { a: [thread('a1', 'a')] },
        update: () => new AssistantApiError('Agent is archived; its threads are read-only', 409),
      });
      assert.equal(await store.rename('a', 'a1', 'New'), false);
      assert.equal(store.getState().threads.a.threads[0].title, 'Thread a1');
      assert.deepEqual(store.getState().notice, { message: 'Agent is archived; its threads are read-only', agentId: 'a', threadId: 'a1' });
    });
  });

  describe('pin / unpin', () => {
    it('pin moves the thread to the top at once and keeps the saved state', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fake = fakeApi({
        agents: [agent('a')],
        threads: {
          a: [thread('new', 'a', { lastActivityAt: '2026-10-05T00:00:00Z' }), thread('old', 'a', { lastActivityAt: '2026-10-01T00:00:00Z' })],
        },
        update: (_k, id, patch) => thread(id, 'a', { pinned: patch.pinned, lastActivityAt: '2026-10-01T00:00:00Z' }),
      });
      const slow = fake.api.updateThread;
      fake.api.updateThread = async (...args) => {
        await gate;
        return slow(...args);
      };
      const store = new AssistantSidebarStore({ api: fake.api });
      await store.load();
      const p = store.setPinned('a', 'old', true);
      assert.deepEqual(store.getState().threads.a.threads.map((t) => [t.id, t.pinned]), [
        ['old', true],
        ['new', false],
      ]);
      assert.equal(store.getState().pending['pin:old'], true);
      release();
      assert.equal(await p, true);
      assert.ok(fake.calls.includes('update:a-key:old:{"pinned":true}'));
      assert.equal(pinnedCount(store.getState(), 'a'), 1);
      assert.deepEqual(store.getState().pending, {});
    });

    it(`the cap (${ASSISTANT_MAX_PINS_PER_AGENT} per agent) is enforced before calling the API`, async () => {
      const many = Array.from({ length: ASSISTANT_MAX_PINS_PER_AGENT }, (_, i) => thread(`p${i}`, 'a', { pinned: true }));
      const { store, calls } = await loaded({ agents: [agent('a')], threads: { a: [...many, thread('extra', 'a')] } });
      assert.equal(await store.setPinned('a', 'extra', true), false);
      assert.ok(!calls.some((c) => c.startsWith('update')));
      assert.equal(store.getState().threads.a.threads.find((t) => t.id === 'extra')!.pinned, false);
      assert.equal(store.getState().notice?.message, `Pin limit reached (${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent)`);
    });

    it('the API refusing a pin (409 cap) reverts it and shows why', async () => {
      const { store } = await loaded({
        agents: [agent('a')],
        threads: { a: [thread('a1', 'a')] },
        update: () => new AssistantApiError(`Pin limit reached (${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent)`, 409),
      });
      assert.equal(await store.setPinned('a', 'a1', true), false);
      assert.equal(store.getState().threads.a.threads[0].pinned, false);
      assert.match(store.getState().notice!.message, /Pin limit reached/);
    });

    it('unpin is allowed at the cap; a failed unpin reverts', async () => {
      const many = Array.from({ length: ASSISTANT_MAX_PINS_PER_AGENT }, (_, i) => thread(`p${i}`, 'a', { pinned: true }));
      let fail = false;
      const { store } = await loaded({
        agents: [agent('a')],
        threads: { a: many },
        update: (_k, id, patch) => (fail ? new AssistantApiError('Internal error', 500) : thread(id, 'a', { pinned: patch.pinned })),
      });
      assert.equal(await store.setPinned('a', 'p0', false), true);
      assert.equal(pinnedCount(store.getState(), 'a'), ASSISTANT_MAX_PINS_PER_AGENT - 1);
      fail = true;
      assert.equal(await store.setPinned('a', 'p1', false), false);
      assert.equal(store.getState().threads.a.threads.find((t) => t.id === 'p1')!.pinned, true);
    });
  });

  describe('selection not found', () => {
    it('unknown agent; thread missing from a complete list; never for a full (paged) list', async () => {
      const full = Array.from({ length: 50 }, (_, i) => thread(`f${i}`, 'b'));
      const { store } = await loaded({ agents: [agent('a'), agent('b')], threads: { a: [thread('a1', 'a')], b: full } });
      const s = store.getState();
      assert.equal(selectionProblem(s, null, null), null);
      assert.equal(selectionProblem(s, 'other-company-agent', 'x'), 'agent-not-found');
      assert.equal(selectionProblem(s, 'a-key', null), null);
      assert.equal(selectionProblem(s, 'a-key', 'a1'), null);
      assert.equal(selectionProblem(s, 'a', 'a1'), null, 'agent id also accepted');
      assert.equal(selectionProblem(s, 'a-key', 'foreign-thread'), 'thread-not-found');
      assert.equal(selectionProblem(s, 'b-key', 'older-thread'), null, 'list may continue beyond the page');
      assert.equal(selectionProblem({ ...s, phase: 'loading' }, 'nope', null), null, 'nothing reported while loading');
      assert.equal(selectionProblem({ ...s, threads: { ...s.threads, a: { ...s.threads.a, status: 'loading' } } }, 'a-key', 'x'), null);
    });
  });

  describe('unread', () => {
    it('opening an unread thread marks it read; a failure restores the marker', async () => {
      let fail = false;
      const { store, calls } = await loaded({
        agents: [agent('a')],
        threads: { a: [thread('a1', 'a', { unread: true }), thread('a2', 'a', { unread: true })] },
        update: (_k, id) => (fail ? new AssistantApiError('Internal error', 500) : thread(id, 'a')),
      });
      await store.markRead('a', 'a1');
      assert.ok(calls.includes('update:a-key:a1:{"read":true}'));
      assert.equal(store.getState().threads.a.threads.find((t) => t.id === 'a1')!.unread, false);
      fail = true;
      await store.markRead('a', 'a2');
      assert.equal(store.getState().threads.a.threads.find((t) => t.id === 'a2')!.unread, true);
      const before = calls.length;
      await store.markRead('a', 'a1'); // already read: no request
      assert.equal(calls.length, before);
    });
  });
});
