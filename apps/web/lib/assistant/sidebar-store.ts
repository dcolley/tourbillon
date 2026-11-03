/**
 * UI-2b: state for the assistant sidebar (framework-free; React binds it with useSyncExternalStore).
 * Agents and their threads come from the UI-2 API (#155). S306-S4: on load every agent's thread
 * list arrives in ONE batch request (GET /api/assistant/threads?agentIds=…, chunked at
 * ASSISTANT_THREADS_BATCH_MAX_AGENTS); single-agent reloads (retry, select) use the per-agent
 * route. The cross-agent sections (Pinned threads, Recent threads, search results) are built
 * from the lists loaded so far.
 */
import {
  ASSISTANT_MAX_PINS_PER_AGENT,
  ASSISTANT_THREAD_LIST_LIMIT,
  ASSISTANT_THREADS_BATCH_MAX_AGENTS,
  checkAssistantThreadTitle,
  filterThreadsByTitle,
  groupSidebarAgents,
  recentThreads,
  sortAssistantThreads,
  type AssistantAgent,
  type AssistantSidebarSections,
  type AssistantThread,
} from './sidebar';
import { AssistantApiError, assistantChatHref, type AssistantSidebarApi } from './sidebar-api';

export interface AgentThreadsState {
  status: 'loading' | 'ready' | 'error';
  threads: AssistantThread[];
  initialThreadId: string | null;
  error: string | null;
}

export interface SidebarNotice {
  message: string;
  agentId?: string;
  threadId?: string;
}

export interface AssistantSidebarState {
  phase: 'loading' | 'ready' | 'error';
  loadError: string | null;
  companyId: string | null;
  agents: AssistantAgent[];
  threads: Record<string, AgentThreadsState>;
  search: string;
  /** Last failed action (rename, pin, new thread, …), shown until dismissed or the next action. */
  notice: SidebarNotice | null;
  /** In-flight actions: `new:<agentId>`, `select:<agentId>`, `pin:<threadId>`, `rename:<threadId>`. */
  pending: Record<string, true>;
}

export const initialSidebarState: AssistantSidebarState = {
  phase: 'loading',
  loadError: null,
  companyId: null,
  agents: [],
  threads: {},
  search: '',
  notice: null,
  pending: {},
};

/** The API's own title rule (shared with the server; see `checkAssistantThreadTitle`). */
export const validateThreadTitle = checkAssistantThreadTitle;

export const pinLimitMessage = () => `Pin limit reached (${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent)`;

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof AssistantApiError || err instanceof Error ? err.message || fallback : fallback;

export interface AgentThreadRef {
  agent: AssistantAgent;
  thread: AssistantThread;
}

// ---- selectors (pure) ----

export function sidebarSections(state: AssistantSidebarState): AssistantSidebarSections {
  // Agent pins are not part of the UI-2 API; the Pinned section lists pinned threads instead.
  return groupSidebarAgents(state.agents);
}

function loadedThreads(state: AssistantSidebarState): AgentThreadRef[] {
  const out: AgentThreadRef[] = [];
  for (const agent of state.agents) {
    for (const thread of state.threads[agent.id]?.threads ?? []) out.push({ agent, thread });
  }
  return out;
}

const byActivity = (refs: AgentThreadRef[]) => {
  const order = new Map(recentThreads(refs.map((r) => r.thread), refs.length).map((t, i) => [t, i]));
  return [...refs].sort((a, b) => order.get(a.thread)! - order.get(b.thread)!);
};

export function pinnedThreads(state: AssistantSidebarState): AgentThreadRef[] {
  return byActivity(loadedThreads(state).filter((r) => r.thread.pinned));
}

export function recentThreadRefs(state: AssistantSidebarState, limit = 8): AgentThreadRef[] {
  return byActivity(loadedThreads(state)).slice(0, limit);
}

/** Threads whose title matches the search (every term, case-insensitive), most recent first. */
export function searchResults(state: AssistantSidebarState): AgentThreadRef[] {
  if (!state.search.trim()) return [];
  const matching = new Set(filterThreadsByTitle(loadedThreads(state).map((r) => r.thread), state.search));
  return byActivity(loadedThreads(state).filter((r) => matching.has(r.thread)));
}

export function pinnedCount(state: AssistantSidebarState, agentId: string): number {
  return (state.threads[agentId]?.threads ?? []).filter((t) => t.pinned).length;
}

/**
 * Whether the URL's selection (`?agent=&thread=`) is missing from the active company: an unknown
 * agent, or a thread absent from the agent's complete list. Lists that hit the page size may
 * hold more threads, so those never report a missing thread.
 */
export function selectionProblem(
  state: AssistantSidebarState,
  agentKey: string | null,
  threadId: string | null,
): 'agent-not-found' | 'thread-not-found' | null {
  if (!agentKey || state.phase !== 'ready') return null;
  const agent = state.agents.find((a) => a.urlKey === agentKey || a.id === agentKey);
  if (!agent) return 'agent-not-found';
  const list = state.threads[agent.id];
  if (!threadId || list?.status !== 'ready' || list.threads.length >= ASSISTANT_THREAD_LIST_LIMIT) return null;
  return list.threads.some((t) => t.id === threadId) ? null : 'thread-not-found';
}

// ---- store ----

export interface AssistantSidebarStoreOptions {
  api: AssistantSidebarApi;
  /**
   * Parallel batch requests while loading every agent's threads (only matters past
   * ASSISTANT_THREADS_BATCH_MAX_AGENTS agents — below that the load is one request).
   */
  concurrency?: number;
  /**
   * Load each agent's thread list after the agents (default true). ASYNC-0 (Slice A): the assistant
   * sidebar passes false; it shows agents only (one conversation per agent).
   */
  threadLists?: boolean;
}

export class AssistantSidebarStore {
  private state: AssistantSidebarState = initialSidebarState;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Bumped by every `load()` and by `dispose()`; a load whose token is stale stops applying results. */
  private loadToken = 0;
  /**
   * S297-S5: one in-flight thread-list request per agent. `load()` asks for every agent's list
   * (S306-S4: in one batch request) and `selectAgent()` may ask for the same agent's list while
   * that is still running; without this map each caller fires its own request. Callers waiting
   * on the same agent share the one request (the batch, or a per-agent one) and see the
   * identical result, so the rendered lists are unchanged. Settled requests leave the map — a
   * later `loadThreads` (e.g. retry after an error) still refetches.
   */
  private threadsInFlight = new Map<string, Promise<AgentThreadsState | undefined>>();
  private readonly api: AssistantSidebarApi;
  private readonly concurrency: number;
  private readonly threadLists: boolean;

  constructor(opts: AssistantSidebarStoreOptions) {
    this.api = opts.api;
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.threadLists = opts.threadLists ?? true;
  }

  getState = (): AssistantSidebarState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Stops updates and abandons any in-flight load. Not terminal: a later `load()` revives the store,
   * because React Strict Mode (dev) runs effect cleanup then setup again on the same `useState`
   * instance. Listeners are owned by their `subscribe` callers, which unsubscribe themselves.
   */
  dispose() {
    this.disposed = true;
    this.loadToken++;
  }

  private update(fn: (s: AssistantSidebarState) => AssistantSidebarState) {
    if (this.disposed) return;
    this.state = fn(this.state);
    for (const l of [...this.listeners]) l();
  }

  private setPending(key: string, on: boolean) {
    this.update((s) => {
      const pending = { ...s.pending };
      if (on) pending[key] = true;
      else delete pending[key];
      return { ...s, pending };
    });
  }

  private setThreads(agentId: string, fn: (t: AgentThreadsState) => AgentThreadsState) {
    this.update((s) => {
      const cur = s.threads[agentId] ?? { status: 'ready', threads: [], initialThreadId: null, error: null };
      return { ...s, threads: { ...s.threads, [agentId]: fn(cur) } };
    });
  }

  private replaceThread(agentId: string, thread: AssistantThread) {
    this.setThreads(agentId, (t) => ({
      ...t,
      threads: sortAssistantThreads(
        t.threads.some((x) => x.id === thread.id) ? t.threads.map((x) => (x.id === thread.id ? thread : x)) : [thread, ...t.threads],
      ),
    }));
  }

  private notify(message: string, ref: { agentId?: string; threadId?: string } = {}) {
    this.update((s) => ({ ...s, notice: { message, ...ref } }));
  }

  dismissNotice() {
    this.update((s) => ({ ...s, notice: null }));
  }

  agent(agentId: string): AssistantAgent | undefined {
    return this.state.agents.find((a) => a.id === agentId);
  }

  /** Agents of the active company, then every agent's threads (S306-S4: one batch request). */
  async load(): Promise<void> {
    this.disposed = false;
    const token = ++this.loadToken;
    const live = () => token === this.loadToken && !this.disposed;
    this.update((s) => ({ ...s, phase: 'loading', loadError: null }));
    let agents: AssistantAgent[];
    try {
      const res = await this.api.listAgents();
      if (!live()) return;
      agents = res.agents;
      this.update((s) => ({ ...s, phase: 'ready', companyId: res.companyId, agents, threads: {} }));
    } catch (err) {
      if (live()) this.update((s) => ({ ...s, phase: 'error', loadError: errorMessage(err, 'Could not load agents') }));
      return;
    }
    if (!this.threadLists || agents.length === 0) return;
    const queue: AssistantAgent[][] = [];
    for (let i = 0; i < agents.length; i += ASSISTANT_THREADS_BATCH_MAX_AGENTS) {
      queue.push(agents.slice(i, i + ASSISTANT_THREADS_BATCH_MAX_AGENTS));
    }
    const worker = async () => {
      for (let chunk = queue.shift(); chunk && live(); chunk = queue.shift()) await this.loadThreadsBatch(chunk, live);
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
  }

  /**
   * S306-S4: one `listThreadsBatch` request for these agents. Each agent's entry in
   * `threadsInFlight` points at this request, so a `selectAgent` / `loadThreads` racing the
   * load shares it instead of firing its own. Agents already in flight are skipped. A failed
   * batch marks every agent in it as failed (retry goes through the per-agent route); an agent
   * the server filtered out (`missing`) or failed (`errors`) is marked failed on its own.
   */
  private async loadThreadsBatch(chunk: AssistantAgent[], live: () => boolean): Promise<void> {
    const batch = chunk.filter((a) => !this.threadsInFlight.has(a.id));
    if (batch.length === 0) return;
    for (const a of batch) this.setThreads(a.id, (t) => ({ ...t, status: 'loading', error: null }));
    // Register the shared per-agent promises BEFORE the request goes out, and drop them in the
    // same tick the batch settles — so a caller right after `load()` always refetches.
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    const requests = new Map<string, Promise<AgentThreadsState | undefined>>();
    for (const a of batch) {
      const request = done.then(() => this.state.threads[a.id]);
      requests.set(a.id, request);
      this.threadsInFlight.set(a.id, request);
    }
    const settled = this.api.listThreadsBatch(batch.map((a) => a.id)).then(
      (res) => {
        if (!live()) return;
        const byKey = new Map(res.agents.map((r) => [r.agentKey, r]));
        const failed = new Map(res.errors.map((e) => [e.agentKey, e.error]));
        const missing = new Set(res.missing);
        for (const a of batch) {
          const r = byKey.get(a.id) ?? res.agents.find((x) => x.agentId === a.id);
          if (r) {
            this.setThreads(a.id, () => ({
              status: 'ready',
              threads: sortAssistantThreads(r.threads),
              initialThreadId: r.initialThreadId,
              error: null,
            }));
          } else {
            const error = failed.get(a.id) ?? (missing.has(a.id) ? 'Agent not found' : 'Could not load threads');
            this.setThreads(a.id, (t) => ({ ...t, status: 'error', error }));
          }
        }
      },
      (err) => {
        if (!live()) return;
        const error = errorMessage(err, 'Could not load threads');
        for (const a of batch) this.setThreads(a.id, (t) => ({ ...t, status: 'error', error }));
      },
    );
    try {
      await settled;
    } finally {
      for (const [id, request] of requests) {
        if (this.threadsInFlight.get(id) === request) this.threadsInFlight.delete(id);
      }
      release();
    }
  }

  async loadThreads(agentId: string): Promise<AgentThreadsState | undefined> {
    // S297-S5: share the single in-flight request per agent (see `threadsInFlight`).
    const pending = this.threadsInFlight.get(agentId);
    if (pending) return pending;
    const request = this.fetchThreads(agentId);
    this.threadsInFlight.set(agentId, request);
    try {
      return await request;
    } finally {
      if (this.threadsInFlight.get(agentId) === request) this.threadsInFlight.delete(agentId);
    }
  }

  private async fetchThreads(agentId: string): Promise<AgentThreadsState | undefined> {
    const agent = this.agent(agentId);
    if (!agent) return undefined;
    this.setThreads(agentId, (t) => ({ ...t, status: 'loading', error: null }));
    try {
      const res = await this.api.listThreads(agent.urlKey);
      this.setThreads(agentId, () => ({
        status: 'ready',
        threads: sortAssistantThreads(res.threads),
        initialThreadId: res.initialThreadId,
        error: null,
      }));
    } catch (err) {
      this.setThreads(agentId, (t) => ({ ...t, status: 'error', error: errorMessage(err, 'Could not load threads') }));
    }
    return this.state.threads[agentId];
  }

  setSearch(search: string) {
    this.update((s) => ({ ...s, search }));
  }

  /**
   * Selecting an agent opens its latest thread, or starts a new one when it has none.
   * Resolves to the chat URL, or null when that failed (see `notice`).
   */
  async selectAgent(agentId: string): Promise<string | null> {
    const agent = this.agent(agentId);
    if (!agent) return null;
    const key = `select:${agentId}`;
    if (this.state.pending[key]) return null;
    this.setPending(key, true);
    try {
      let threads: AgentThreadsState | undefined = this.state.threads[agentId];
      if (!threads || threads.status !== 'ready') threads = await this.loadThreads(agentId);
      if (!threads || threads.status !== 'ready') {
        this.notify(threads?.error ?? 'Could not load threads', { agentId });
        return null;
      }
      if (threads.initialThreadId) return assistantChatHref(agent.urlKey, threads.initialThreadId);
      return await this.createThread(agent);
    } finally {
      this.setPending(key, false);
    }
  }

  /** New thread for the agent; resolves to its chat URL, or null on failure. */
  async newThread(agentId: string): Promise<string | null> {
    const agent = this.agent(agentId);
    if (!agent) return null;
    return this.createThread(agent);
  }

  private async createThread(agent: AssistantAgent): Promise<string | null> {
    const key = `new:${agent.id}`;
    if (this.state.pending[key]) return null;
    this.setPending(key, true);
    try {
      const thread = await this.api.createThread(agent.urlKey);
      this.replaceThread(agent.id, thread);
      this.setThreads(agent.id, (t) => ({ ...t, status: 'ready', initialThreadId: t.initialThreadId ?? thread.id }));
      return assistantChatHref(agent.urlKey, thread.id);
    } catch (err) {
      this.notify(errorMessage(err, 'Could not start a new thread'), { agentId: agent.id });
      return null;
    } finally {
      this.setPending(key, false);
    }
  }

  /** Rename; resolves false (with a notice) when the title is invalid or the request failed. */
  async rename(agentId: string, threadId: string, rawTitle: string): Promise<boolean> {
    const agent = this.agent(agentId);
    if (!agent) return false;
    const valid = validateThreadTitle(rawTitle);
    if (!valid.ok) {
      this.notify(valid.error, { agentId, threadId });
      return false;
    }
    const key = `rename:${threadId}`;
    this.setPending(key, true);
    try {
      this.replaceThread(agentId, await this.api.updateThread(agent.urlKey, threadId, { title: valid.title }));
      this.update((s) => ({ ...s, notice: null }));
      return true;
    } catch (err) {
      this.notify(errorMessage(err, 'Could not rename the thread'), { agentId, threadId });
      return false;
    } finally {
      this.setPending(key, false);
    }
  }

  /**
   * Pin / unpin (per user). Pinning past the cap is refused locally when the loaded list already
   * holds the maximum, and by the API (409) otherwise; either way the thread stays unpinned.
   */
  async setPinned(agentId: string, threadId: string, pinned: boolean): Promise<boolean> {
    const agent = this.agent(agentId);
    const before = this.state.threads[agentId]?.threads.find((t) => t.id === threadId);
    if (!agent || !before) return false;
    if (before.pinned === pinned) return true;
    if (pinned && pinnedCount(this.state, agentId) >= ASSISTANT_MAX_PINS_PER_AGENT) {
      this.notify(pinLimitMessage(), { agentId, threadId });
      return false;
    }
    const key = `pin:${threadId}`;
    if (this.state.pending[key]) return false;
    this.setPending(key, true);
    this.replaceThread(agentId, { ...before, pinned }); // optimistic
    try {
      this.replaceThread(agentId, await this.api.updateThread(agent.urlKey, threadId, { pinned }));
      return true;
    } catch (err) {
      const current = this.state.threads[agentId]?.threads.find((t) => t.id === threadId);
      if (current) this.replaceThread(agentId, { ...current, pinned: before.pinned });
      this.notify(errorMessage(err, pinned ? 'Could not pin the thread' : 'Could not unpin the thread'), {
        agentId,
        threadId,
      });
      return false;
    } finally {
      this.setPending(key, false);
    }
  }

  /** Opening a thread clears its unread marker (best effort; restored if the request fails). */
  async markRead(agentId: string, threadId: string): Promise<void> {
    const agent = this.agent(agentId);
    const thread = this.state.threads[agentId]?.threads.find((t) => t.id === threadId);
    if (!agent || !thread?.unread) return;
    this.replaceThread(agentId, { ...thread, unread: false });
    try {
      await this.api.updateThread(agent.urlKey, threadId, { read: true });
    } catch {
      const current = this.state.threads[agentId]?.threads.find((t) => t.id === threadId);
      if (current) this.replaceThread(agentId, { ...current, unread: true });
    }
  }
}
