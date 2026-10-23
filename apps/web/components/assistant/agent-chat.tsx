'use client';

/**
 * AGUI-1b: minimal assistant-view chat over the AG-UI endpoint: streamed text, reasoning and tool
 * calls, run status, stop / steer / follow-up while a run is open, tool approval, and the delivery of
 * each message (queued, dropped, failed). UI-2 adds the agent/thread sidebar; CHAT-1 the composer.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { WidgetToolCall } from '@/components/assistant/widgets/widget-tool-call';
import { assistantWidgetRegistry } from '@/components/assistant/widgets/registry';
import type { ToolCardStatus } from '@/components/assistant/widgets/fallback-card';
import type {
  AgentChatItem,
  AgentChatState,
  PendingToolDecision,
  ToolCallStatus,
  UserMessageDelivery,
} from '@/lib/agui/client/chat-state';
import type { AguiThreadRef } from '@/lib/agui/client/thread-bootstrap';
import { useAgentChat, type AgentChatPhase } from './use-agent-chat';

const DELIVERY_LABEL: Partial<Record<UserMessageDelivery, string>> = {
  sending: 'Sending…',
  queued: 'Queued — runs after the current reply',
  dropped: 'Not sent — the run ended first',
  failed: 'Not sent',
};

const STATUS_LABEL: Record<AgentChatState['status'], string> = {
  idle: 'Idle',
  starting: 'Starting…',
  running: 'Responding…',
  stopping: 'Stopping…',
};

function toolCardStatus(status: ToolCallStatus): ToolCardStatus {
  if (status === 'done') return 'done';
  if (status === 'error' || status === 'denied' || status === 'detached') return 'failed';
  return 'running';
}

function ItemView({ item }: { item: AgentChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1" data-item="user" data-delivery={item.delivery} data-mode={item.mode}>
          <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
          {item.mode === 'steer' && <span className="text-xs text-muted-foreground">Steer</span>}
          {DELIVERY_LABEL[item.delivery] && (
            <span className="text-xs text-muted-foreground">{DELIVERY_LABEL[item.delivery]}</span>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="whitespace-pre-wrap text-sm" data-item="assistant" data-streaming={item.streaming ? 'true' : 'false'}>
          {item.text}
        </div>
      );
    case 'reasoning':
      return (
        <details className="text-xs text-muted-foreground" data-item="reasoning">
          <summary>Reasoning</summary>
          <div className="whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case 'tool':
      return (
        <div data-item="tool" data-tool-status={item.status}>
          <WidgetToolCall
            registry={assistantWidgetRegistry}
            toolCall={{ toolCallId: item.id, toolName: item.name, args: item.argsText || undefined }}
            toolStatus={toolCardStatus(item.status)}
          />
        </div>
      );
  }
}

export interface AgentChatViewProps {
  phase: AgentChatPhase;
  setupError: string | null;
  state: AgentChatState;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
  onToolDecision: (toolCallId: string, approved: boolean) => void;
  onDismissError: () => void;
}

function PendingTool({ tool, onDecision }: { tool: PendingToolDecision; onDecision: AgentChatViewProps['onToolDecision'] }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm" data-pending-tool={tool.toolCallId}>
      <span>
        {tool.reason === 'tool_approval' ? 'Approve' : 'Continue'} <span className="font-mono">{tool.toolName}</span>?
      </span>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => onDecision(tool.toolCallId, true)}>
          Approve
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onDecision(tool.toolCallId, false)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

/** Stateless view (tested with react-dom/server). */
export function AgentChatView(props: AgentChatViewProps) {
  const { phase, setupError, state, draft } = props;
  if (phase === 'connecting') {
    return <p className="p-6 text-sm text-muted-foreground">Opening chat…</p>;
  }
  if (phase === 'error') {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {setupError ?? 'Could not open the chat'}
      </p>
    );
  }
  const runOpen = state.status !== 'idle';
  const canSend = draft.trim().length > 0 && state.status !== 'stopping';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agent-chat data-status={state.status}>
      <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {state.items.map((item) => (
          <ItemView key={`${item.kind}:${item.id}`} item={item} />
        ))}
        {state.pendingTools.map((tool) => (
          <PendingTool key={tool.toolCallId} tool={tool} onDecision={props.onToolDecision} />
        ))}
      </div>
      {state.error && (
        <div role="alert" className="mx-4 flex items-center justify-between gap-2 rounded-md border border-destructive/40 p-2 text-sm" data-error={state.error.kind}>
          <span>{state.error.message}</span>
          <Button type="button" size="sm" variant="ghost" onClick={props.onDismissError}>
            Dismiss
          </Button>
        </div>
      )}
      <form
        className="flex flex-col gap-2 border-t p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) props.onSend();
        }}
      >
        <textarea
          aria-label="Message"
          className="min-h-16 w-full resize-none rounded-md border bg-transparent p-2 text-sm"
          value={draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          placeholder={runOpen ? 'Send a follow-up or steer the reply' : 'Message the agent'}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-run-status>
            {STATUS_LABEL[state.status]}
          </span>
          <div className="flex-1" />
          {runOpen && (
            <>
              <Button type="button" size="sm" variant="outline" disabled={!canSend} onClick={props.onSteer}>
                Steer
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={state.status === 'stopping'} onClick={props.onStop}>
                Stop
              </Button>
            </>
          )}
          <Button type="submit" size="sm" disabled={!canSend}>
            {runOpen ? 'Follow up' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** The current page URL with `thread=<id>` set (path, query and hash only). */
export function withThreadParam(href: string, threadId: string): string {
  const url = new URL(href);
  url.searchParams.set('thread', threadId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function AgentChat({ agentId, threadId }: { agentId: string; threadId?: string }) {
  // Without a thread in the URL, record the opened thread there so a reload reopens it.
  const onThreadOpened = React.useCallback(
    (ref: AguiThreadRef) => {
      if (threadId || typeof window === 'undefined') return;
      window.history.replaceState(null, '', withThreadParam(window.location.href, ref.threadId));
    },
    [threadId],
  );
  const chat = useAgentChat({ agentId, threadId, onThreadOpened });
  const [draft, setDraft] = React.useState('');
  const submit = (fn: ((text: string) => Promise<{ ok: boolean }> | undefined) | undefined) => {
    const text = draft;
    if (!text.trim() || !fn) return;
    setDraft('');
    void fn(text)?.then((r) => {
      // Keep the text when it was refused (e.g. 409) so it can be sent again.
      if (!r.ok) setDraft((current) => (current === '' ? text : current));
    });
  };
  return (
    <AgentChatView
      phase={chat.phase}
      setupError={chat.setupError}
      state={chat.state}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => submit(chat.send)}
      onSteer={() => submit(chat.steer)}
      onStop={() => void chat.abort()}
      onToolDecision={(id, approved) => void chat.respondToTool(id, approved)}
      onDismissError={chat.clearError}
    />
  );
}
