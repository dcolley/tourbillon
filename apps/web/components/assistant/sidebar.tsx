'use client';

/**
 * UI-2b: assistant sidebar — the active company's agents by section (My agents, Teams by role) with
 * their status. Links go to `/assistant/<agent-url-key>` (lib/assistant/route.ts).
 *
 * ASYNC-0 (Slice A): one conversation per agent, so the sidebar is the agents rail only: no thread
 * trees, no New chat / rename / pin, no Pinned or Recent threads, and no thread search. Selecting an
 * agent opens its chat (its current conversation).
 *
 * Collapsible rail: shown from the `sm` breakpoint up (iPad portrait and desktop), either as the full
 * list or as an icon rail (agent initials only). The choice is kept in localStorage
 * (ASSISTANT_SIDEBAR_COLLAPSED_KEY). Phones still get no sidebar (agents drawer deferred).
 */
import * as React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { parseAssistantPath } from '@/lib/assistant/route';
import { Button } from '@/components/ui/button';
import type { AssistantAgent } from '@/lib/assistant/sidebar';
import { selectionProblem, sidebarSections, type AssistantSidebarState } from '@/lib/assistant/sidebar-store';
import { useAssistantSidebar } from './use-assistant-sidebar';
import { assistantChatHref } from '@/lib/assistant/sidebar-api';

export interface AssistantSidebarViewProps {
  state: AssistantSidebarState;
  currentAgentKey: string | null;
  onSelectAgent: (agentId: string) => void;
  onRetry: () => void;
  onDismissNotice: () => void;
  /** Icon rail (agent initials only) instead of the full list. */
  collapsed?: boolean;
  /** Switches between the icon rail and the full list; no toggle without it. */
  onToggleCollapsed?: () => void;
}

/** A plain left click is handled in the app; modified clicks keep the browser's link behaviour. */
export function inAppClick(e: React.MouseEvent, go: () => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** localStorage key for the rail / full list choice ('true' = icon rail). */
export const ASSISTANT_SIDEBAR_COLLAPSED_KEY = 'tourbillon.assistant.sidebarCollapsed';

/** Last choice made on this page, used when localStorage is unavailable. */
let collapsedFallback = false;
const collapsedListeners = new Set<() => void>();

export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(ASSISTANT_SIDEBAR_COLLAPSED_KEY);
    return stored === null ? collapsedFallback : stored === 'true';
  } catch {
    return collapsedFallback;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  collapsedFallback = collapsed;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ASSISTANT_SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }
  for (const listener of collapsedListeners) listener();
}

function subscribeSidebarCollapsed(listener: () => void): () => void {
  collapsedListeners.add(listener);
  // Another tab changed the choice.
  window.addEventListener('storage', listener);
  return () => {
    collapsedListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The rail / full list choice; the server render (and first client render) is the full list. */
function useSidebarCollapsed(): boolean {
  return React.useSyncExternalStore(subscribeSidebarCollapsed, readSidebarCollapsed, () => false);
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
  const current = props.currentAgentKey === agent.urlKey || props.currentAgentKey === agent.id;
  return (
    <li data-agent={agent.urlKey} data-current={current ? 'true' : undefined}>
      <div className={`flex items-center gap-1 rounded px-1 py-1 ${current ? 'bg-muted' : 'hover:bg-muted/60'}`}>
        <a
          href={assistantChatHref(agent.urlKey)}
          className={`flex min-w-0 flex-1 items-center gap-2 text-sm ${agent.active ? '' : 'opacity-60'}`}
          aria-current={current ? 'page' : undefined}
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

function CollapseToggle({ props }: { props: AssistantSidebarViewProps }) {
  if (!props.onToggleCollapsed) return null;
  const label = props.collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar';
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-expanded={!props.collapsed}
      data-sidebar-toggle
      onClick={props.onToggleCollapsed}
    >
      {props.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
    </Button>
  );
}

const STATUS_DOT: Partial<Record<AssistantAgent['status'], string>> = {
  waiting: 'bg-amber-500',
  running: 'bg-emerald-500',
};

/** Icon rail: one initials button per agent (same order as the full list), current agent marked. */
function AgentRail({ props }: { props: AssistantSidebarViewProps }) {
  const { state } = props;
  if (state.agents.length === 0) return null;
  const sections = sidebarSections(state);
  const ordered = [...sections.myAgents, ...sections.teams.flatMap((t) => t.agents)];
  const seen = new Set(ordered.map((a) => a.id));
  for (const a of state.agents) if (!seen.has(a.id)) ordered.push(a);
  return (
    <ul className="flex flex-col items-center gap-1" data-agent-rail>
      {ordered.map((agent) => {
        const current = props.currentAgentKey === agent.urlKey || props.currentAgentKey === agent.id;
        const dot = STATUS_DOT[agent.status];
        const label = `${agent.name}${agent.status === 'waiting' ? ' (waiting on you)' : agent.status === 'running' ? ' (running)' : ''}${agent.active ? '' : ' (paused)'}`;
        return (
          <li key={agent.id} data-agent={agent.urlKey} data-current={current ? 'true' : undefined}>
            <a
              href={assistantChatHref(agent.urlKey)}
              aria-label={label}
              title={label}
              aria-current={current ? 'page' : undefined}
              className={`relative flex size-8 items-center justify-center rounded-full text-[0.65rem] font-semibold ${
                current ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/60'
              } ${agent.active ? '' : 'opacity-60'}`}
              onClick={(e) => inAppClick(e, () => props.onSelectAgent(agent.id))}
            >
              {initials(agent.name)}
              {dot && (
                <span
                  aria-hidden
                  className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-background ${dot}`}
                  data-agent-status={agent.status}
                />
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Stateless sidebar (tested with react-dom/server). */
export function AssistantSidebarView(props: AssistantSidebarViewProps) {
  const { state } = props;
  if (props.collapsed) {
    return (
      <aside
        aria-label="Agents"
        className="hidden w-14 shrink-0 flex-col items-center gap-3 overflow-y-auto border-r p-2 sm:flex"
        data-assistant-sidebar
        data-collapsed="true"
      >
        <CollapseToggle props={props} />
        {state.phase === 'error' ? (
          <Button type="button" size="xs" variant="outline" title={state.loadError ?? 'Could not load agents'} onClick={props.onRetry}>
            Retry
          </Button>
        ) : (
          <AgentRail props={props} />
        )}
      </aside>
    );
  }
  const problem = selectionProblem(state, props.currentAgentKey, null);
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
  } else {
    const sections = sidebarSections(state);
    body = (
      <>
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
      </>
    );
  }
  return (
    <aside
      aria-label="Agents"
      className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3 sm:flex"
      data-assistant-sidebar
      data-collapsed="false"
    >
      <div className="flex items-center gap-1">
        <h2 className="min-w-0 flex-1 px-2 text-sm font-semibold">Agents</h2>
        <CollapseToggle props={props} />
      </div>
      {problem && (
        <p role="status" className="rounded-md border p-2 text-xs text-muted-foreground" data-selection-problem={problem}>
          That agent is not in this company. Pick an agent from the list.
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

/** The agent in the URL (`/assistant/<agent-url-key>`). */
function useCurrentAgentKey(): string | null {
  return parseAssistantPath(usePathname()).agent;
}

export function AssistantSidebar() {
  // ASYNC-0: agents only (no thread lists are loaded).
  const { store, state } = useAssistantSidebar({ threadLists: false });
  const router = useRouter();
  const currentAgentKey = useCurrentAgentKey();
  const collapsed = useSidebarCollapsed();
  return (
    <AssistantSidebarView
      state={state}
      currentAgentKey={currentAgentKey}
      onSelectAgent={(id) => {
        const agent = store.agent(id);
        if (agent) router.push(assistantChatHref(agent.urlKey));
      }}
      onRetry={() => void store.load()}
      onDismissNotice={() => store.dismissNotice()}
      collapsed={collapsed}
      onToggleCollapsed={() => writeSidebarCollapsed(!collapsed)}
    />
  );
}
