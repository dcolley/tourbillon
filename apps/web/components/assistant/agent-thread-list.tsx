'use client';

/**
 * UI-2b: one agent's threads in the assistant sidebar — open, new, rename (inline), pin/unpin,
 * unread marker. Stateless: the sidebar owns the edit draft and the store owns the data.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { assistantChatHref } from '@/lib/assistant/sidebar-api';
import { ASSISTANT_MAX_PINS_PER_AGENT, type AssistantAgent, type AssistantThread } from '@/lib/assistant/sidebar';
import type { AgentThreadsState } from '@/lib/assistant/sidebar-store';

export interface ThreadEditState {
  threadId: string;
  draft: string;
}

export interface ThreadRowHandlers {
  onOpenThread: (agentId: string, threadId: string, href: string) => void;
  onPin: (agentId: string, threadId: string, pinned: boolean) => void;
  onStartRename: (threadId: string, title: string) => void;
  onRenameDraft: (draft: string) => void;
  onRenameSubmit: (agentId: string, threadId: string) => void;
  onRenameCancel: () => void;
}

export const threadTitle = (t: Pick<AssistantThread, 'title'>) => t.title.trim() || 'Untitled thread';

/** Plain left clicks navigate in-app; modified clicks keep the browser's default (new tab, …). */
export function inAppClick(e: React.MouseEvent, go: () => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

export function ThreadRow({
  agent,
  thread,
  current,
  editing,
  pending,
  pinCapReached,
  showAgent,
  handlers,
}: {
  agent: AssistantAgent;
  thread: AssistantThread;
  current: boolean;
  editing: ThreadEditState | null;
  pending: Record<string, true>;
  pinCapReached: boolean;
  /** In cross-agent lists (Pinned, Recent, search results). */
  showAgent?: boolean;
  handlers: ThreadRowHandlers;
}) {
  const href = assistantChatHref(agent.urlKey, thread.id);
  const isEditing = editing?.threadId === thread.id;
  const pinDisabled = Boolean(pending[`pin:${thread.id}`]) || (!thread.pinned && pinCapReached);
  if (isEditing) {
    return (
      <form
        className="flex items-center gap-1 px-2 py-1"
        data-thread-edit={thread.id}
        onSubmit={(e) => {
          e.preventDefault();
          handlers.onRenameSubmit(agent.id, thread.id);
        }}
      >
        <input
          aria-label="Thread title"
          className="h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-sm"
          value={editing.draft}
          maxLength={200}
          autoFocus
          onChange={(e) => handlers.onRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handlers.onRenameCancel();
          }}
        />
        <Button type="submit" size="xs" disabled={Boolean(pending[`rename:${thread.id}`])}>
          Save
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={handlers.onRenameCancel}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <div
      className={`group flex items-center gap-1 rounded px-2 py-1 text-sm ${current ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`}
      data-thread={thread.id}
      data-current={current ? 'true' : undefined}
    >
      <a
        href={href}
        className="flex min-w-0 flex-1 items-center gap-2"
        aria-current={current ? 'page' : undefined}
        onClick={(e) => inAppClick(e, () => handlers.onOpenThread(agent.id, thread.id, href))}
      >
        {thread.unread && <span className="size-2 shrink-0 rounded-full bg-primary" data-unread aria-label="Unread" />}
        <span className="truncate">{threadTitle(thread)}</span>
        {showAgent && <span className="shrink-0 truncate text-xs text-muted-foreground">· {agent.name}</span>}
      </a>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
        aria-pressed={thread.pinned}
        title={!thread.pinned && pinCapReached ? `Pin limit reached (${ASSISTANT_MAX_PINS_PER_AGENT} threads per agent)` : undefined}
        disabled={pinDisabled}
        onClick={() => handlers.onPin(agent.id, thread.id, !thread.pinned)}
      >
        {thread.pinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Rename thread"
        onClick={() => handlers.onStartRename(thread.id, thread.title)}
      >
        Rename
      </Button>
    </div>
  );
}

export function AgentThreadList({
  agent,
  threads,
  currentThreadId,
  editing,
  pending,
  handlers,
  onNewThread,
  onRetry,
}: {
  agent: AssistantAgent;
  threads: AgentThreadsState | undefined;
  currentThreadId: string | null;
  editing: ThreadEditState | null;
  pending: Record<string, true>;
  handlers: ThreadRowHandlers;
  onNewThread: (agentId: string) => void;
  onRetry: (agentId: string) => void;
}) {
  const list = threads?.threads ?? [];
  const pinCapReached = list.filter((t) => t.pinned).length >= ASSISTANT_MAX_PINS_PER_AGENT;
  return (
    <div className="ml-6 flex flex-col gap-0.5 py-1" data-agent-threads={agent.id}>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="mx-2 self-start"
        disabled={Boolean(pending[`new:${agent.id}`])}
        onClick={() => onNewThread(agent.id)}
      >
        New thread
      </Button>
      {(!threads || threads.status === 'loading') && list.length === 0 && (
        <p className="px-2 text-xs text-muted-foreground">Loading threads…</p>
      )}
      {threads?.status === 'error' && (
        <div role="alert" className="flex items-center gap-2 px-2 text-xs text-destructive">
          <span>{threads.error}</span>
          <Button type="button" size="xs" variant="ghost" onClick={() => onRetry(agent.id)}>
            Retry
          </Button>
        </div>
      )}
      {threads?.status === 'ready' && list.length === 0 && (
        <p className="px-2 text-xs text-muted-foreground">No threads yet</p>
      )}
      {list.map((t) => (
        <ThreadRow
          key={t.id}
          agent={agent}
          thread={t}
          current={t.id === currentThreadId}
          editing={editing}
          pending={pending}
          pinCapReached={pinCapReached}
          handlers={handlers}
        />
      ))}
    </div>
  );
}
