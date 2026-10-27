'use client';

/**
 * AGUI-1b: minimal assistant-view chat over the AG-UI endpoint: streamed text, reasoning and tool
 * calls, run status, stop / steer / follow-up while a run is open, tool approval, and the delivery of
 * each message (queued, dropped, failed). Rendered by the /assistant/<agent>[/<threadId>] pages
 * (assistant-route-view.tsx).
 *
 * WID-3: the registered chat cards (question, choice, form, confirm) are declared to every run as
 * frontend tools; a card the run waits on is answered or dismissed in place (no Approve / Decline row).
 * While the run is parked on a card (its stream has ended; a new message is refused until the card is
 * answered or dismissed), a notice names the card and offers to dismiss it or stop the run; cards still
 * waiting are shown again when the chat is reopened (use-agent-chat → restorePending).
 *
 * CHAT-PAGE-1: the transcript opens on its newest page (20 messages) with a Load previous control at the
 * top while older messages exist; loading them keeps the view in place. The list opens at the bottom and
 * stays pinned there while content streams, until the user scrolls up; scrolling back down, sending, or
 * Jump to latest pins it again (use-sticky-transcript.ts).
 */
import * as React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatMarkdown } from '@/components/assistant/message-markdown';
import { ToolStateCard } from '@/components/assistant/tool-state-card';
import { WidgetToolCall } from '@/components/assistant/widgets/widget-tool-call';
import { assistantWidgetRegistry, type WidgetRegistry } from '@/components/assistant/widgets/registry';
import { parseStoredWidgetAnswer } from '@tourbillon/shared/widgets';
import { approvalCardCallFor } from '@/components/assistant/widgets/approval-card-binding';
import type { ToolCardStatus } from '@/components/assistant/widgets/fallback-card';
import type {
  AgentChatItem,
  AgentChatState,
  ParkedWidget,
  PendingToolDecision,
  ToolCallStatus,
  UserMessageDelivery,
} from '@/lib/agui/client/chat-state';
import type { AguiThreadRef } from '@/lib/agui/client/thread-bootstrap';
import type { AgentChatResult, AgentChatSendOptions } from '@/lib/agui/client/agent-chat-client';
import { contextChipLabel, type OpenInChatContext } from '@/lib/assistant/open-in-chat';
import { assistantAgentPath } from '@/lib/assistant/sidebar';
import { feedbackTargets } from '@/lib/assistant/feedback';
import { MessageFeedback, useThreadFeedback } from './message-feedback';
import { useAgentChat, type AgentChatPhase } from './use-agent-chat';
import { ModelPicker } from './model-picker/model-picker';
import { ContextMeter } from './context-meter/context-meter';
import { DmActivityStripView } from './dm-activity';
import { DmConversationModal } from './dm-peek-dialog';
import { useAgentDms } from './use-agent-dms';
import {
  buildConversations,
  dmChipText,
  dmDirection,
  dmPeer,
  dmSnippet,
  dmStripSummary,
  dmTranscriptChips,
  mergeDmTranscriptTimeline,
  type AgentDm,
} from '@/lib/assistant/agent-dms';
import { AgentChatMenu } from './agent-chat-menu';
import { clearAgentChat, type AssistantOmSummary } from '@/lib/assistant/single-chat';
import { useStickyTranscript } from './use-sticky-transcript';

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
  if (status === 'error' || status === 'denied' || status === 'detached' || status === 'stopped') return 'failed';
  return 'running';
}

/** WID-3: how a widget call ended, read from its tool result: answered (with the answer) or dismissed. */
export function widgetOutcome(item: Extract<AgentChatItem, { kind: 'tool' }>): { answer?: unknown; dismissed: boolean } {
  if (item.result === undefined || item.status === 'error') return { dismissed: false };
  const stored = parseStoredWidgetAnswer(item.id, item.name, item.result);
  if (stored) return { answer: stored.answer, dismissed: false };
  try {
    const value = JSON.parse(item.result) as { widget?: unknown; dismissed?: unknown };
    return { dismissed: value?.widget === item.name && value?.dismissed === true };
  } catch {
    return { dismissed: false };
  }
}

/** Whether a tool name is a registered widget the user answers in place (no approve / decline row). */
const isAnsweredInPlace = (registry: WidgetRegistry, toolName: string) => Boolean(registry.latest(toolName)?.frontendTool);

interface WidgetHandlers {
  registry: WidgetRegistry;
  onWidgetAnswer?: (toolCallId: string, answer: unknown) => void;
  onWidgetDismiss?: (toolCallId: string) => void;
}

/**
 * CHAT-2: assistant text renders as markdown (message-markdown.tsx: code blocks and tables with copy
 * controls, no raw HTML). Plain tool calls render as tool-state cards (tool-state-card.tsx); tool
 * calls with a registered widget still go through the widget registry.
 */
function ItemView({ item, widgets }: { item: AgentChatItem; widgets: WidgetHandlers }) {
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
    case 'tool': {
      const outcome = widgetOutcome(item);
      const send = item.widgetSend;
      const busy = send?.phase === 'sending' || send?.phase === 'sent';
      return (
        <div data-item="tool" data-tool-status={item.status}>
          {approvalCardCallFor(item) || widgets.registry.latest(item.name) ? (
            <WidgetToolCall
              registry={widgets.registry}
              // WID-2: a finished createApproval / getApproval call shows the Board approval card.
              toolCall={approvalCardCallFor(item) ?? { toolCallId: item.id, toolName: item.name, args: item.argsText || undefined }}
              toolStatus={toolCardStatus(item.status)}
              answer={outcome.answer}
              dismissed={outcome.dismissed}
              // Only a call the run is waiting on takes an answer.
              answerable={item.status === 'suspended' && Boolean(widgets.onWidgetAnswer)}
              busy={busy && outcome.answer === undefined && !outcome.dismissed}
              attempt={send?.attempts ?? 0}
              onAnswer={
                widgets.onWidgetAnswer
                  ? ({ record }) => widgets.onWidgetAnswer?.(item.id, (record as { answer: unknown }).answer)
                  : undefined
              }
              onDismiss={widgets.onWidgetDismiss ? () => widgets.onWidgetDismiss?.(item.id) : undefined}
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
          {item.status === 'stopped' && (
            <p className="mt-1 text-xs text-muted-foreground">Run stopped — this card no longer takes an answer.</p>
          )}
        </div>
      );
    }
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
  /** OBS-2: footer under each finished assistant message (reactions), by Mastra message id. */
  assistantFooter?: (messageId: string) => React.ReactNode;
  /** CHAT-5: the thread's model picker, shown in the composer footer. */
  modelPicker?: React.ReactNode;
  /** UI-3: page context to send with the next message, shown as a removable chip. */
  contextChip?: OpenInChatContext | null;
  onRemoveContext?: () => void;
  /** WID-3: answer / dismiss a card the run waits on (cards are read-only without these). */
  onWidgetAnswer?: (toolCallId: string, answer: unknown) => void;
  onWidgetDismiss?: (toolCallId: string) => void;
  /** Widget registry (default: the assistant registry). */
  registry?: WidgetRegistry;
  /** WID-3: link to another chat of this agent (a card waiting there); no link without it. */
  chatHref?: (threadId: string) => string;
  /** DM-1: the agent's DM activity strip (read-only), shown above the message list. */
  dmActivity?: React.ReactNode;
  /**
   * DM-2: the agent's DMs (A2A mail) shown as chips in the transcript, merged by timestamp.
   * Display only: chips are neither model context nor stored thread content (see agent-dms.ts).
   */
  dms?: readonly AgentDm[];
  /** DM-2: this chat's agent (chips and the modal read each pair from its side). */
  agentId?: string;
  /** DM-2: start of the current conversation (epoch ms): chips cover DMs from that time on only. */
  dmThreadStartedAt?: number | null;
  /** DM-2: opens the conversation modal on this peer and message (from the strip or a chip). */
  onOpenDm?: (peerId?: string, messageId?: string) => void;
  /** ASYNC-0: the chat's ⋯ menu (Clear chat, Observational Memory), at the end of the chat chrome. */
  chatMenu?: React.ReactNode;
  /** CHAT-PAGE-1: load the previous transcript page (Load previous is shown while `state.history.hasMore`). */
  onLoadPrevious?: () => void;
  /** CHAT-PAGE-1: the scrolling message list (sticky-bottom binding). */
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: () => void;
  /** CHAT-PAGE-1: false once the user scrolled up; shows Jump to latest (with `onJumpToLatest`). */
  pinned?: boolean;
  onJumpToLatest?: () => void;
}

const CARD_KIND: Record<string, string> = {
  askQuestion: 'question',
  askChoice: 'choice',
  askForm: 'form',
  askConfirm: 'confirmation',
};

function cardLabel(argsText: string | undefined, args?: unknown): string | undefined {
  let value = args;
  if (value === undefined && argsText) {
    try {
      value = JSON.parse(argsText);
    } catch {
      return undefined;
    }
  }
  const a = value as { question?: unknown; title?: unknown } | null;
  const raw = typeof a?.question === 'string' ? a.question : typeof a?.title === 'string' ? a.title : undefined;
  const text = raw?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * WID-3: the card the run is parked on: as reported by the endpoint, else (no run open) the first card
 * of this chat still waiting for an answer.
 */
export function parkedCard(state: AgentChatState, registry: WidgetRegistry): ParkedWidget | null {
  if (state.parked) return state.parked;
  if (state.status !== 'idle') return null;
  const tool = state.pendingTools.find((t) => t.reason === 'tool_suspended' && isAnsweredInPlace(registry, t.toolName));
  if (!tool) return null;
  const item = state.items.find((it) => it.kind === 'tool' && it.id === tool.toolCallId) as
    | Extract<AgentChatItem, { kind: 'tool' }>
    | undefined;
  const label = cardLabel(item?.argsText, item ? undefined : tool.args);
  return { threadId: '', toolCallId: tool.toolCallId, toolName: tool.toolName, ...(label ? { label } : {}), elsewhere: false };
}

function ParkedNotice({
  parked,
  state,
  props,
}: {
  parked: ParkedWidget;
  state: AgentChatState;
  props: AgentChatViewProps;
}) {
  const kind = parkedCardKind(parked);
  const item = state.items.find((it) => it.kind === 'tool' && it.id === parked.toolCallId);
  const dismissable = !parked.elsewhere && item?.kind === 'tool' && item.status === 'suspended' && Boolean(props.onWidgetDismiss);
  const href = parked.elsewhere && props.chatHref ? props.chatHref(parked.threadId) : undefined;
  return (
    <div
      role="status"
      className="mx-4 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
      data-parked-widget={parked.toolCallId}
      data-parked-elsewhere={parked.elsewhere ? 'true' : 'false'}
    >
      {parked.elsewhere ? (
        // ASYNC-0 (Slice B): a card left on an earlier conversation (e.g. before Clear chat) cannot be
        // answered here; stopping its run frees the agent to continue in this conversation.
        <span>
          {'A ' + kind + ' from an earlier conversation'}
          {parked.label ? ` (“${parked.label}”)` : ''} is still waiting for an answer. Stop it to continue here.
        </span>
      ) : (
        <span>
          {'The ' + kind}
          {parked.label ? ` (“${parked.label}”)` : ''} is waiting for your answer. Answer or dismiss it, or stop the run,
          to send a new message.
        </span>
      )}
      <div className="flex gap-2">
        {href && (
          <a className="text-sm underline" href={href}>
            Open that chat
          </a>
        )}
        {dismissable && (
          <Button type="button" size="sm" variant="outline" onClick={() => props.onWidgetDismiss?.(parked.toolCallId)}>
            Dismiss card
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={props.onStop} data-parked-stop>
          {parked.elsewhere ? 'Stop it and continue here' : 'Stop'}
        </Button>
      </div>
    </div>
  );
}

/** "approval card", "choice card", … for a parked card. */
export function parkedCardKind(parked: Pick<ParkedWidget, 'toolName'>): string {
  return `${CARD_KIND[parked.toolName] ?? 'widget'} card`;
}

/** Slice B: the waiting card as the Clear chat confirm names it, e.g. `choice card (“Pick a plan”)`. */
export function pendingCardDescription(parked: ParkedWidget | null): string | null {
  if (!parked) return null;
  return parkedCardKind(parked) + (parked.label ? ` (“${parked.label}”)` : '');
}

/** UI-3: the page context (from an Open in chat link) waiting to go with the next message. */
export function ContextChip({ context, onRemove }: { context: OpenInChatContext; onRemove?: () => void }) {
  const label = contextChipLabel(context);
  return (
    <div
      data-slot="context-chip"
      data-context-type={context.contextType}
      data-context-id={context.contextId}
      title={`${label} — sent with your next message`}
      className="flex w-fit max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
    >
      <span className="truncate">{label}</span>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove context" onClick={onRemove}>
        <X />
      </Button>
    </div>
  );
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

/**
 * DM-2: one DM as a quiet chip in the transcript (display only — never model context, never stored).
 * The chip keeps the message to one line; expanding peeks the body inline, and "Open conversation"
 * opens the conversation modal on this message.
 */
export function DmChatChip({
  mail,
  agentId,
  onOpenDm,
}: {
  mail: AgentDm;
  agentId: string;
  onOpenDm?: (peerId?: string, messageId?: string) => void;
}) {
  const dir = dmDirection(mail, agentId);
  const peer = dmPeer(mail, agentId);
  const snippet = dmSnippet(mail.body);
  return (
    <div className="flex flex-col items-start gap-1" data-dm-chip={mail.id} data-dm-peer={peer.id} data-dm-direction={dir}>
      <details className="max-w-[80%] rounded-md border p-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          {dmChipText(mail, agentId)}
          {snippet ? ` · ${snippet}` : ''}
        </summary>
        <div className="mt-1 space-y-1.5">
          <ChatMarkdown text={mail.body} />
          {onOpenDm ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-dm-open-conversation={mail.id}
              onClick={() => onOpenDm(peer.id, mail.id)}
            >
              Open conversation
            </Button>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/** Stateless view (tested with react-dom/server). */
export function AgentChatView(props: AgentChatViewProps) {
  const { phase, setupError, state, draft, scrollRef } = props;
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
  const widgets: WidgetHandlers = {
    registry: props.registry ?? assistantWidgetRegistry,
    onWidgetAnswer: props.onWidgetAnswer,
    onWidgetDismiss: props.onWidgetDismiss,
  };
  const runOpen = state.status !== 'idle';
  const parked = parkedCard(state, widgets.registry);
  const canSend = draft.trim().length > 0 && state.status !== 'stopping';
  const footers = props.assistantFooter ? feedbackTargets(state.items, runOpen) : null;
  // DM-2: merge the agent's DMs into the transcript rows by timestamp (display only — chips are not
  // model context and never join a message sent to the model). Keys and order are stable across polls.
  const chips =
    props.agentId && props.dms && props.dms.length > 0
      ? dmTranscriptChips(props.dms, { threadStartedAt: props.dmThreadStartedAt })
      : [];
  const rows = mergeDmTranscriptTimeline(state.items, chips);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agent-chat data-status={state.status}>
      {props.dmActivity || props.chatMenu ? (
        <div className="flex min-h-9 items-center gap-2 border-b px-4 py-1" data-chat-chrome>
          <div className="min-w-0 flex-1">{props.dmActivity ?? null}</div>
          {props.chatMenu ?? null}
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={props.onScroll}
        className="relative flex-1 space-y-3 overflow-y-auto p-4"
        aria-live="polite"
        data-transcript
        data-pinned={props.pinned === false ? 'false' : 'true'}
      >
        {state.history?.hasMore && props.onLoadPrevious ? (
          <div className="flex justify-center" data-load-previous>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={state.history.loading}
              aria-busy={state.history.loading || undefined}
              onClick={props.onLoadPrevious}
            >
              {state.history.loading ? 'Loading…' : 'Load previous'}
            </Button>
          </div>
        ) : null}
        {rows.map((row) => {
          if (row.kind === 'dm') {
            return <DmChatChip key={row.key} mail={row.mail} agentId={props.agentId ?? ''} onOpenDm={props.onOpenDm} />;
          }
          const footerFor = footers?.get(row.item.id);
          return (
            <React.Fragment key={row.key}>
              <ItemView item={row.item} widgets={widgets} />
              {footerFor && props.assistantFooter?.(footerFor)}
            </React.Fragment>
          );
        })}
        {state.pendingTools
          .filter((tool) => !(tool.reason === 'tool_suspended' && isAnsweredInPlace(widgets.registry, tool.toolName)))
          .map((tool) => (
            <PendingTool key={tool.toolCallId} tool={tool} onDecision={props.onToolDecision} />
          ))}
      </div>
      {props.pinned === false && props.onJumpToLatest ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center" data-jump-to-latest>
          <Button type="button" size="sm" variant="secondary" className="pointer-events-auto shadow" onClick={props.onJumpToLatest}>
            Jump to latest
          </Button>
        </div>
      ) : null}
      </div>
      {parked && <ParkedNotice parked={parked} state={state} props={props} />}
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
        {props.contextChip ? <ContextChip context={props.contextChip} onRemove={props.onRemoveContext} /> : null}
        <textarea
          aria-label="Message"
          className="min-h-16 w-full resize-none rounded-md border bg-transparent p-2 text-sm"
          value={draft}
          onChange={(e) => props.onDraftChange(e.target.value)}
          placeholder={runOpen ? 'Send a follow-up or steer the reply' : 'Message the agent'}
        />
        <div className="flex items-center gap-2">
          {props.modelPicker ? <div data-composer-model-picker>{props.modelPicker}</div> : null}
          <span
            className="text-xs text-muted-foreground"
            data-run-status
            data-parked={parked ? 'true' : undefined}
            data-reconnecting={state.reconnecting ? 'true' : undefined}
          >
            {parked && state.status === 'idle'
              ? 'Waiting for your answer'
              : state.reconnecting
                ? 'Reconnecting…'
                : STATUS_LABEL[state.status]}
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
 * Link to the agent's chat. ASYNC-0 (Slice A): one conversation per agent, so the link is the agent
 * path `/assistant/<agent url key>` (lib/assistant/sidebar.ts assistantAgentPath) and never names a thread.
 */
export function agentChatHref(agentKey: string): string {
  return assistantAgentPath(agentKey);
}

/** WID-3: the chat cards, declared to every run as frontend tools (the server offers only those it knows). */
const CHAT_CARD_TOOLS = assistantWidgetRegistry.frontendTools();

/**
 * DM-2: the conversation cut-off time (ms) for transcript chips. The thread's own start time when
 * the bootstrap answer carries it (see thread-bootstrap.ts), else the moment this client first saw
 * the thread — snapshotted per thread identity, so it never wanders between renders and the clock
 * is never called mid-render.
 */
const UNKNOWN_THREAD_START = new WeakMap<object, number>();
function threadStartMs(thread: { threadId: string; threadCreatedAt?: string }): number {
  const known = thread.threadCreatedAt ? Date.parse(thread.threadCreatedAt) : Number.NaN;
  if (!Number.isNaN(known)) return known;
  const seen = UNKNOWN_THREAD_START.get(thread);
  if (seen !== undefined) return seen;
  const now = Date.now();
  UNKNOWN_THREAD_START.set(thread, now);
  return now;
}

/**
 * Chat with one agent. `agentId` is used for the API calls; `agentKey` (the agent's url key, default
 * `agentId`) for the page link, so the address bar keeps the canonical `/assistant/<url key>`.
 * ASYNC-0: the agent's one conversation (its pinned active thread, Slice B). Clear chat (⋯ menu)
 * starts a fresh one in place (lib/assistant/single-chat.ts); there is no New chat and no thread
 * switching. A remount (e.g. switching agents and back) reopens the pinned thread from the server.
 */
export function AgentChat({
  agentId,
  agentKey,
  threadId,
  initialContext,
  companyId,
}: {
  agentId: string;
  agentKey?: string;
  threadId?: string;
  /** DM-1: active company; with it the chat shows the agent's DM activity strip. */
  companyId?: string;
  /** UI-3: page context from an Open in chat link; sent with the first message unless removed. */
  initialContext?: OpenInChatContext;
}) {
  const linkKey = agentKey ?? agentId;
  // The address bar shows the agent path (never a thread): a reload reopens the agent's current conversation.
  const onThreadOpened = React.useCallback(
    (_ref: AguiThreadRef) => {
      if (typeof window === 'undefined') return;
      const href = agentChatHref(linkKey);
      if (window.location.pathname + window.location.search !== href) window.history.replaceState(null, '', href);
    },
    [linkKey],
  );
  // ASYNC-0: after Clear chat, the fresh thread (else the given one, else the agent's pinned active thread).
  const [clearedThreadId, setClearedThreadId] = React.useState<string | undefined>(undefined);
  const activeThreadId = clearedThreadId ?? threadId;
  const chat = useAgentChat({ agentId, threadId: activeThreadId, tools: CHAT_CARD_TOOLS, onThreadOpened });
  const feedback = useThreadFeedback(agentId, chat.thread?.threadId ?? null);
  // Slice B: OM mode for the ⋯ menu, from the thread open (GET …/threads) or the last Clear.
  const [clearedOm, setClearedOm] = React.useState<AssistantOmSummary | undefined>(undefined);
  const observationalMemory = clearedOm ?? chat.thread?.observationalMemory ?? null;
  const parkedNow = parkedCard(chat.state, assistantWidgetRegistry);
  // CHAT-PAGE-1: open at the bottom, stay pinned while content streams, until the user scrolls up.
  // A new thread (Clear chat) remounts nothing, so the key resets the binding through `ready`.
  const scroll = useStickyTranscript([chat.state.items, chat.state.pendingTools, chat.thread?.threadId], chat.phase === 'ready');
  const loadPrevious = () => {
    scroll.beforePrepend();
    void Promise.resolve(chat.loadPrevious()).finally(scroll.afterPrepend);
  };
  const [draft, setDraft] = React.useState('');
  const [context, setContext] = React.useState<OpenInChatContext | null>(initialContext ?? null);
  // CTX-1: reload the context meter on open, after each turn (back to idle) and on a model change.
  const [modelRev, setModelRev] = React.useState(0);
  const bumpModelRev = React.useCallback(() => setModelRev((n) => n + 1), []);
  const meterRefreshKey =
    chat.state.status === 'idle' ? `idle:${chat.state.items.length}:${chat.state.runId ?? ''}:${modelRev}` : null;
  const submit = (
    fn: ((text: string, opts?: AgentChatSendOptions) => Promise<AgentChatResult> | undefined) | undefined,
  ) => {
    const text = draft;
    if (!text.trim() || !fn) return;
    const sentContext = context;
    // CHAT-PAGE-1: sending re-pins the transcript to the bottom.
    scroll.pin('send');
    setDraft('');
    setContext(null);
    void fn(text, sentContext ? { context: sentContext } : undefined)?.then((r) => {
      // Keep the text (and the context chip) when it was refused (e.g. 409) so it can be sent again.
      if (!r.ok) {
        setDraft((current) => (current === '' ? text : current));
        if (sentContext) setContext((current) => current ?? sentContext);
      }
    });
  };
  // DM-2: one client-side read of the agent's DMs (polled while the page is visible) feeds the
  // transcript chips, the strip and the conversation modal. Display only — sendToAgent is unchanged.
  const dms = useAgentDms(companyId, agentId);
  const dmConversations = React.useMemo(() => buildConversations(dms.mails, agentId), [dms.mails, agentId]);
  const dmSummary = React.useMemo(() => dmStripSummary(dmConversations), [dmConversations]);
  // Start time (ms) of this conversation (the chips cut-off): the true thread start when the API
  // carries it, else the client-side time this chat was opened (snapshotted once per thread by
  // `threadStartMs`). Clear chat begins a new conversation (chips after that only); the modal
  // keeps showing the full durable history either way.
  const dmThreadStartedAt = chat.thread ? threadStartMs(chat.thread) : null;
  // The conversation modal (opened from the strip or a chip). `key` remounts it per open, so the
  // selection and the read-marks (client-only, no server unread state) start fresh each time.
  const [dmModal, setDmModal] = React.useState<{ open: boolean; seq: number; peerId?: string; messageId?: string }>({
    open: false,
    seq: 0,
  });
  const openDm = (peerId?: string, messageId?: string) => {
    setDmModal((s) => ({ open: true, seq: s.seq + 1, ...(peerId ? { peerId } : {}), ...(messageId ? { messageId } : {}) }));
  };
  return (
    <>
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
      onWidgetAnswer={(id, answer) => void chat.answerWidget(id, answer)}
      onWidgetDismiss={(id) => void chat.dismissWidget(id)}
      onDismissError={chat.clearError}
      onLoadPrevious={loadPrevious}
      scrollRef={scroll.ref}
      onScroll={scroll.onScroll}
      pinned={scroll.pinned}
      onJumpToLatest={() => scroll.pin('jump')}
      assistantFooter={
        chat.thread
          ? (messageId) => (
              <MessageFeedback key={messageId} messageId={messageId} saved={feedback.feedback[messageId] ?? null} onSave={feedback.save} />
            )
          : undefined
      }
      contextChip={context}
      onRemoveContext={() => setContext(null)}
      dmActivity={companyId ? <DmActivityStripView summary={dmSummary} onOpen={() => openDm()} /> : undefined}
      dms={dms.mails}
      agentId={agentId}
      dmThreadStartedAt={dmThreadStartedAt}
      onOpenDm={openDm}
      chatMenu={
        <AgentChatMenu
          agentUrlKey={linkKey}
          runOpen={chat.state.status !== 'idle'}
          observationalMemory={observationalMemory}
          pendingCard={pendingCardDescription(parkedNow)}
          onClear={async () => {
            // Slice B: a run parked on a card would stay on the old thread and refuse new messages;
            // stop it first (the confirm says so) so nothing is left waiting where it cannot be answered.
            if (parkedNow) {
              const stopped = await chat.abort();
              if (stopped && !stopped.ok) return { ok: false as const, error: 'Could not stop the waiting card' };
            }
            // The server pins the new thread as active and moves the AgentController session (and so
            // Observational Memory) onto it.
            const r = await clearAgentChat(agentId);
            if (r.ok) {
              setDraft('');
              setContext(null);
              if (r.observationalMemory) setClearedOm(r.observationalMemory);
              setClearedThreadId(r.threadId);
            }
            return r;
          }}
        />
      }
      modelPicker={
        chat.thread ? (
          <div className="flex items-center gap-2">
            <ModelPicker
              agentId={agentId}
              threadId={chat.thread.threadId}
              disabled={chat.state.status !== 'idle'}
              onStateChange={bumpModelRev}
            />
            <ContextMeter agentId={agentId} threadId={chat.thread.threadId} refreshKey={meterRefreshKey} />
          </div>
        ) : undefined
      }
      />
      {dmConversations.length > 0 ? (
        <DmConversationModal
          key={`dm-modal-${dmModal.seq}`}
          open={dmModal.open}
          onOpenChange={(open) => setDmModal((s) => (s.open === open ? s : { ...s, open }))}
          agentId={agentId}
          mails={dms.mails}
          error={dms.error}
          focus={dmModal.peerId || dmModal.messageId ? { peerId: dmModal.peerId, messageId: dmModal.messageId } : null}
        />
      ) : null}
    </>
  );
}
