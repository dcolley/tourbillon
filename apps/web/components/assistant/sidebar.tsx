'use client';

/**
 * UI-2b: assistant sidebar — the active company's agents by section (Pinned threads, My agents,
 * Teams by role, Recent threads) with each agent's threads: open, new, rename, pin, search, unread.
 * Links go to `/assistant/<agent-url-key>[/<threadId>]` (lib/assistant/route.ts).
 */
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { parseAssistantPath } from '@/lib/assistant/route';
import { Button } from '@/components/ui/button';
import { ASSISTANT_MAX_PINS_PER_AGENT, type AssistantAgent } from '@/lib/assistant/sidebar';
import {
  pinnedCount,
  pinnedThreads,
  recentThreadRefs,
  searchResults,
  selectionProblem,
  sidebarSections,
  type AgentThreadRef,
  type AssistantSidebarState,
} from '@/lib/assistant/sidebar-store';
import { AgentThreadList, ThreadRow, inAppClick, type ThreadEditState, type ThreadRowHandlers } from './agent-thread-list';
import { useAssistantSidebar } from './use-assistant-sidebar';
import { assistantChatHref } from '@/lib/assistant/sidebar-api';

export interface AssistantSidebarViewProps extends ThreadRowHandlers {
  state: AssistantSidebarState;
  currentAgentKey: string | null;
  currentThreadId: string | null;
  expanded: ReadonlySet<string>;
  editing: ThreadEditState | null;
  onSearch: (q: string) => void;
  onSelectAgent: (agentId: string) => void;
  onToggleAgent: (agentId: string) => void;
  onNewThread: (agentId: string) => void;
  onRetryThreads: (agentId: string) => void;
  onRetry: () => void;
  onDismissNotice: () => void;
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1).replace(/[_-]+/g, ' ');

function AgentStatus({ agent }: { agent: AssistantAgent }) {
  if (agent.status === 'waiting') {
    return (
      <span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-[0.7rem] text-amber-700 dark:text-amber-400" data-agent-status="waiting">
        Waiting on you{agent.pendingApprovals > 1 ? ` (${agent.pendingApprovals})` : ''}
      </span>
    );
  }
  if (agent.status === 'running') {
    return (
      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 text-[0.7rem] text-emerald-700 dark:text-emerald-400" data-agent-status="running">
        Running
      </span>
    );
  }
  return <span className="sr-only" data-agent-status="idle">Idle</span>;
}

function AgentRow({ agent, props }: { agent: AssistantAgent; props: AssistantSidebarViewProps }) {
  const open = props.expanded.has(agent.id);
  const current = props.currentAgentKey === agent.urlKey || props.currentAgentKey === agent.id;
  return (
    <li data-agent={agent.urlKey} data-current={current ? 'true' : undefined}>
      <div className={`flex items-center gap-1 rounded px-1 py-1 ${current ? 'bg-muted' : 'hover:bg-muted/60'}`}>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={open ? `Hide ${agent.name} threads` : `Show ${agent.name} threads`}
          aria-expanded={open}
          onClick={() => props.onToggleAgent(agent.id)}
        >
          {open ? '▾' : '▸'}
        </Button>
        <a
          href={assistantChatHref(agent.urlKey)}
          className={`flex min-w-0 flex-1 items-center gap-2 text-sm ${agent.active ? '' : 'opacity-60'}`}
          aria-busy={props.state.pending[`select:${agent.id}`] ? true : undefined}
          onClick={(e) => inAppClick(e, () => props.onSelectAgent(agent.id))}
        >
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-semibold"
          >
            {initials(agent.name)}
          </span>
          <span className="truncate">{agent.name}</span>
          {!agent.active && <span className="text-[0.7rem] text-muted-foreground">Paused</span>}
        </a>
        <AgentStatus agent={agent} />
      </div>
      {open && (
        <AgentThreadList
          agent={agent}
          threads={props.state.threads[agent.id]}
          currentThreadId={current ? props.currentThreadId : null}
          editing={props.editing}
          pending={props.state.pending}
          handlers={props}
          onNewThread={props.onNewThread}
          onRetry={props.onRetryThreads}
        />
      )}
    </li>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`assistant-sidebar-${id}`} data-section={id} className="flex flex-col gap-1">
      <h2 id={`assistant-sidebar-${id}`} className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ThreadRefList({ refs, props }: { refs: AgentThreadRef[]; props: AssistantSidebarViewProps }) {
  return (
    <div className="flex flex-col gap-0.5">
      {refs.map(({ agent, thread }) => (
        <ThreadRow
          key={`${agent.id}:${thread.id}`}
          agent={agent}
          thread={thread}
          current={thread.id === props.currentThreadId}
          editing={props.editing}
          pending={props.state.pending}
          pinCapReached={pinnedCount(props.state, agent.id) >= ASSISTANT_MAX_PINS_PER_AGENT}
          showAgent
          handlers={props}
        />
      ))}
    </div>
  );
}

/** Stateless sidebar (tested with react-dom/server). */
export function AssistantSidebarView(props: AssistantSidebarViewProps) {
  const { state } = props;
  const problem = selectionProblem(state, props.currentAgentKey, props.currentThreadId);
  let body: React.ReactNode;
  if (state.phase === 'loading' && state.agents.length === 0) {
    body = <p className="px-2 text-sm text-muted-foreground">Loading agents…</p>;
  } else if (state.phase === 'error') {
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 px-2 text-sm text-destructive">
        <span>{state.loadError ?? 'Could not load agents'}</span>
        <Button type="button" size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  } else if (state.agents.length === 0) {
    body = <p className="px-2 text-sm text-muted-foreground">No agents in this company yet.</p>;
  } else if (state.search.trim()) {
    const results = searchResults(state);
    body = (
      <Section title="Results" id="results">
        {results.length ? (
          <ThreadRefList refs={results} props={props} />
        ) : (
          <p className="px-2 text-sm text-muted-foreground">No threads match “{state.search.trim()}”</p>
        )}
      </Section>
    );
  } else {
    const sections = sidebarSections(state);
    const pinned = pinnedThreads(state);
    const recent = recentThreadRefs(state);
    body = (
      <>
        {pinned.length > 0 && (
          <Section title="Pinned" id="pinned">
            <ThreadRefList refs={pinned} props={props} />
          </Section>
        )}
        {sections.myAgents.length > 0 && (
          <Section title="My agents" id="my-agents">
            <ul className="flex flex-col gap-0.5">
              {sections.myAgents.map((a) => (
                <AgentRow key={a.id} agent={a} props={props} />
              ))}
            </ul>
          </Section>
        )}
        {sections.teams.length > 0 && (
          <Section title="Teams" id="teams">
            {sections.teams.map((team) => (
              <div key={team.role} data-team={team.role}>
                <h3 className="px-2 pt-1 text-xs text-muted-foreground">{roleLabel(team.role)}</h3>
                <ul className="flex flex-col gap-0.5">
                  {team.agents.map((a) => (
                    <AgentRow key={a.id} agent={a} props={props} />
                  ))}
                </ul>
              </div>
            ))}
          </Section>
        )}
        {recent.length > 0 && (
          <Section title="Recent threads" id="recent">
            <ThreadRefList refs={recent} props={props} />
          </Section>
        )}
      </>
    );
  }
  return (
    <aside aria-label="Agents" className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3 md:flex" data-assistant-sidebar>
      <input
        type="search"
        aria-label="Search threads"
        placeholder="Search threads"
        className="h-8 rounded-md border bg-transparent px-2 text-sm"
        value={state.search}
        onChange={(e) => props.onSearch(e.target.value)}
      />
      {problem && (
        <p role="status" className="rounded-md border p-2 text-xs text-muted-foreground" data-selection-problem={problem}>
          {problem === 'agent-not-found'
            ? 'That agent is not in this company. Pick an agent from the list.'
            : 'That thread was not found for this agent. Pick a thread from the list.'}
        </p>
      )}
      {state.notice && (
        <div role="alert" className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 p-2 text-xs" data-notice>
          <span>{state.notice.message}</span>
          <Button type="button" size="xs" variant="ghost" onClick={props.onDismissNotice}>
            Dismiss
          </Button>
        </div>
      )}
      {body}
    </aside>
  );
}

/** The agent / thread in the URL (`/assistant/<agent-url-key>[/<threadId>]`). */
function useCurrentSelection(): { agent: string | null; thread: string | null } {
  return parseAssistantPath(usePathname());
}

export function AssistantSidebar() {
  const { store, state } = useAssistantSidebar();
  const router = useRouter();
  const current = useCurrentSelection();
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = React.useState<ThreadEditState | null>(null);

  // The agent in the URL is shown expanded, and its open thread is marked read.
  const currentAgent = state.agents.find((a) => a.urlKey === current.agent || a.id === current.agent);
  const currentAgentId = currentAgent?.id ?? null;
  const currentThreadLoaded = Boolean(
    currentAgentId && current.thread && state.threads[currentAgentId]?.threads.some((t) => t.id === current.thread),
  );
  React.useEffect(() => {
    if (currentAgentId && current.thread && currentThreadLoaded) void store.markRead(currentAgentId, current.thread);
  }, [store, currentAgentId, current.thread, currentThreadLoaded]);
  // A thread missing from the loaded list may be newer than the list (e.g. created by the chat
  // view): reload that agent's threads once before reporting it as not found.
  const problem = selectionProblem(state, current.agent, current.thread);
  const recheckedRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (problem !== 'thread-not-found' || !currentAgentId || !current.thread) return;
    const key = `${currentAgentId}\u0000${current.thread}`;
    if (recheckedRef.current.has(key)) return;
    recheckedRef.current.add(key);
    void store.loadThreads(currentAgentId);
  }, [store, problem, currentAgentId, current.thread]);
  const shown = React.useMemo(() => {
    if (!currentAgentId || expanded.has(currentAgentId)) return expanded;
    return new Set([...expanded, currentAgentId]);
  }, [expanded, currentAgentId]);

  const go = (href: string | null) => {
    if (href) router.push(href);
  };
  return (
    <AssistantSidebarView
      state={state}
      currentAgentKey={current.agent}
      currentThreadId={current.thread}
      expanded={shown}
      editing={editing}
      onSearch={(q) => store.setSearch(q)}
      onSelectAgent={(id) => void store.selectAgent(id).then(go)}
      onToggleAgent={(id) =>
        setExpanded(() => {
          const next = new Set(shown);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onNewThread={(id) => void store.newThread(id).then(go)}
      onRetryThreads={(id) => void store.loadThreads(id)}
      onRetry={() => void store.load()}
      onDismissNotice={() => store.dismissNotice()}
      onOpenThread={(agentId, threadId, href) => {
        void store.markRead(agentId, threadId);
        router.push(href);
      }}
      onPin={(agentId, threadId, pinned) => void store.setPinned(agentId, threadId, pinned)}
      onStartRename={(threadId, title) => setEditing({ threadId, draft: title })}
      onRenameDraft={(draft) => setEditing((e) => (e ? { ...e, draft } : e))}
      onRenameSubmit={(agentId, threadId) => {
        const draft = editing?.threadId === threadId ? editing.draft : '';
        void store.rename(agentId, threadId, draft).then((ok) => {
          if (ok) setEditing((e) => (e?.threadId === threadId ? null : e));
        });
      }}
      onRenameCancel={() => setEditing(null)}
    />
  );
}
