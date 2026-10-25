'use client';

/**
 * AGUI-1b: minimal assistant-view chat over the AG-UI endpoint: streamed text, reasoning and tool
 * calls, run status, stop / steer / follow-up while a run is open, tool approval, and the delivery of
 * each message (queued, dropped, failed). Rendered by the /assistant/<agent>[/<threadId>] pages
 * (assistant-route-view.tsx).
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ChatMarkdown } from '@/components/assistant/message-markdown';
import { ToolStateCard } from '@/components/assistant/tool-state-card';
import { WidgetToolCall } from '@/components/assistant/widgets/widget-tool-call';
import { assistantWidgetRegistry } from '@/components/assistant/widgets/registry';
import { approvalCardCallFor } from '@/components/assistant/widgets/approval-card-binding';
import type { ToolCardStatus } from '@/components/assistant/widgets/fallback-card';
import type {
  AgentChatItem,
  AgentChatState,
  PendingToolDecision,
  ToolCallStatus,
  UserMessageDelivery,
} from '@/lib/agui/client/chat-state';
import type { AguiThreadRef } from '@/lib/agui/client/thread-bootstrap';
import { assistantAgentPath } from '@/lib/assistant/sidebar';
import { useAgentChat, type AgentChatPhase } from './use-agent-chat';
import { ModelPicker } from './model-picker/model-picker';

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

/**
 * CHAT-2: assistant text renders as markdown (message-markdown.tsx: code blocks and tables with copy
 * controls, no raw HTML). Plain tool calls render as tool-state cards (tool-state-card.tsx); tool
 * calls with a registered widget still go through the widget registry.
 */
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
        <div className="text-sm" data-item="assistant" data-streaming={item.streaming ? 'true' : 'false'}>
          <ChatMarkdown text={item.text} />
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
          {approvalCardCallFor(item) || assistantWidgetRegistry.latest(item.name) ? (
            <WidgetToolCall
              registry={assistantWidgetRegistry}
              // WID-2: a finished createApproval / getApproval call shows the Board approval card.
              toolCall={approvalCardCallFor(item) ?? { toolCallId: item.id, toolName: item.name, args: item.argsText || undefined }}
              toolStatus={toolCardStatus(item.status)}
            />
          ) : (
            <ToolStateCard
              toolCallId={item.id}
              toolName={item.name}
              status={item.status}
              argsText={item.argsText}
              result={item.result}
            />
          )}
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
  /** CHAT-5: the thread's model picker, shown in the composer footer. */
  modelPicker?: React.ReactNode;
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
          {props.modelPicker ? <div data-composer-model-picker>{props.modelPicker}</div> : null}
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

/**
 * Link to an opened chat: the assistant path form `/assistant/<agent url key>/<threadId>`
 * (lib/assistant/sidebar.ts assistantAgentPath, the route shape UI-2b serves).
 */
export function agentChatHref(agentKey: string, threadId: string): string {
  return assistantAgentPath(agentKey, threadId);
}

/**
 * Chat with one agent. `agentId` is used for the API calls; `agentKey` (the agent's url key, default
 * `agentId`) for the page link, so the address bar keeps the canonical `/assistant/<url key>/<thread>`.
 */
export function AgentChat({ agentId, agentKey, threadId }: { agentId: string; agentKey?: string; threadId?: string }) {
  const linkKey = agentKey ?? agentId;
  // Once the thread is open, show its link in the address bar so a reload reopens it.
  const onThreadOpened = React.useCallback(
    (ref: AguiThreadRef) => {
      if (typeof window === 'undefined') return;
      const href = agentChatHref(linkKey, ref.threadId);
      if (window.location.pathname + window.location.search !== href) window.history.replaceState(null, '', href);
    },
    [linkKey],
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
      modelPicker={
        chat.thread ? (
          <ModelPicker agentId={agentId} threadId={chat.thread.threadId} disabled={chat.state.status !== 'idle'} />
        ) : undefined
      }
    />
  );
}
