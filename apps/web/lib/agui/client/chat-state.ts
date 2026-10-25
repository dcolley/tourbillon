/**
 * AGUI-1b: client-side state for one AG-UI agent chat thread, as a pure reducer over the events the
 * AG-UI endpoint sends (lib/agui/session-events.ts) plus the client's own actions. No React here;
 * see agent-chat-client.ts for the run / control state machine and components/assistant/* for the UI.
 */
import type { AguiClientEvent } from './sse';

/** CUSTOM event names sent by the endpoint (mirrors AGUI_CUSTOM in lib/agui/session-events.ts). */
export const AGUI_CLIENT_CUSTOM = {
  toolApprovalRequired: 'tourbillon.tool_approval_required',
  toolSuspended: 'tourbillon.tool_suspended',
  followUpQueued: 'tourbillon.follow_up_queued',
  followUpDropped: 'tourbillon.follow_up_dropped',
  control: 'tourbillon.control',
} as const;

/**
 * - idle: nothing running for this client;
 * - starting: run request sent, no RUN_STARTED yet;
 * - running: the run stream is open;
 * - stopping: abort requested, waiting for the run to end.
 */
export type AgentChatStatus = 'idle' | 'starting' | 'running' | 'stopping';

/** What happened to a message the user sent. */
export type UserMessageDelivery =
  | 'sending'
  /** Follow-up accepted while a run is open; runs after the current turn. */
  | 'queued'
  | 'delivered'
  /** Queued follow-up that will not run (run aborted, failed, ended first, or the stream was lost). */
  | 'dropped'
  /** Refused or failed to send (see `error`). */
  | 'failed';

export type ToolCallStatus =
  | 'streaming_args'
  | 'running'
  | 'awaiting_approval'
  | 'suspended'
  | 'done'
  | 'error'
  | 'denied'
  /** WID-3: a card whose parked run was stopped; it no longer takes an answer. */
  | 'stopped'
  /** Approved after the run had ended: this client is not connected to the continued run, so no result will arrive here. */
  | 'detached';

export type AgentChatItem =
  | { kind: 'user'; id: string; text: string; mode: 'run' | 'followUp' | 'steer'; delivery: UserMessageDelivery }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      argsText: string;
      status: ToolCallStatus;
      result?: string;
      parentMessageId?: string;
      /**
       * WID-3: a widget answer or dismissal sent from this client for this call: `sending` while the
       * request is out, `sent` once the endpoint resumed the run (the card stays locked until the tool
       * result arrives), `failed` when it was refused (the card can be answered again; `attempts`
       * counts the failures so the card resets).
       */
      widgetSend?: { phase: WidgetSendPhase; attempts: number };
    };

export interface PendingToolDecision {
  toolCallId: string;
  toolName: string;
  reason: 'tool_approval' | 'tool_suspended';
  args: unknown;
}

export type AgentChatErrorKind =
  /** 409: another run or session holds the thread. */
  | 'conflict'
  /** Other non-2xx response (auth, not found, bad input). */
  | 'http'
  /** RUN_ERROR from the agent. */
  | 'run'
  /** The run stream ended without RUN_FINISHED / RUN_ERROR. */
  | 'disconnected'
  /** fetch failed or the body could not be read / parsed. */
  | 'network'
  /** A control request was answered but not applied (e.g. a tool decision with nothing pending). */
  | 'rejected'
  /** The run ended cancelled although this client did not ask to stop it. */
  | 'cancelled'
  /** A tool was approved after the run ended; its progress and result cannot be shown in this chat. */
  | 'detached';

export interface AgentChatError {
  kind: AgentChatErrorKind;
  message: string;
  status?: number;
  /** WID-3: a send refused because this chat's session has a run parked on a card (409). */
  pendingWidget?: ParkedWidget;
}

/**
 * WID-3: a card the session's run is parked on, as reported by the endpoint (`pending` action, or the
 * 409 of a refused send). The run stays parked until the card is answered or dismissed, or the run is
 * stopped; until then a new message is refused.
 */
export interface ParkedWidget {
  /** Thread of the parked run. */
  threadId: string;
  toolCallId: string;
  toolName: string;
  label?: string;
  /** True when the card is on another thread than this chat's. */
  elsewhere: boolean;
}

/** WID-3: a card still waiting on this chat's thread, as the endpoint's `pending` action lists it. */
export interface PendingWidgetCard {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type AgentRunOutcome = 'success' | 'cancelled' | 'interrupt' | 'error' | 'disconnected';

/** Shown when a run ends cancelled without the user pressing Stop. */
export const RUN_CANCELLED_MESSAGE = 'Run cancelled: the reply was stopped before it finished.';
/** Shown when a tool is approved after its run has ended. */
export const TOOL_DETACHED_MESSAGE =
  'Approved, but this chat is no longer connected to the run, so the tool’s progress and result cannot be shown here.';

export interface AgentChatState {
  status: AgentChatStatus;
  runId: string | null;
  items: AgentChatItem[];
  /** Tool calls waiting for an approve / decline (or a resume of a suspended tool). */
  pendingTools: PendingToolDecision[];
  /** Follow-ups the agent runtime reports as queued (tourbillon.follow_up_queued). */
  runtimeQueuedFollowUps: number;
  /** Queued follow-ups of the current run already marked dropped (the server reports a running total). */
  droppedThisRun: number;
  error: AgentChatError | null;
  lastOutcome: AgentRunOutcome | null;
  /** WID-3: the card the session's run is parked on, when the endpoint reported one (else null). */
  parked: ParkedWidget | null;
}

export const initialAgentChatState: AgentChatState = {
  status: 'idle',
  runId: null,
  items: [],
  pendingTools: [],
  runtimeQueuedFollowUps: 0,
  droppedThisRun: 0,
  error: null,
  lastOutcome: null,
  parked: null,
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function updateItem(
  state: AgentChatState,
  id: string,
  kind: AgentChatItem['kind'],
  fn: (item: any) => AgentChatItem,
): AgentChatState {
  const i = state.items.findIndex((it) => it.id === id && it.kind === kind);
  if (i < 0) return state;
  const items = state.items.slice();
  items[i] = fn(items[i]);
  return { ...state, items };
}

function upsertItem(state: AgentChatState, item: AgentChatItem): AgentChatState {
  const i = state.items.findIndex((it) => it.id === item.id && it.kind === item.kind);
  if (i >= 0) return state;
  return { ...state, items: [...state.items, item] };
}

function closeStreaming(items: AgentChatItem[]): AgentChatItem[] {
  return items.map((it) =>
    (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming ? { ...it, streaming: false } : it,
  );
}

function setDelivery(
  items: AgentChatItem[],
  pick: (it: Extract<AgentChatItem, { kind: 'user' }>) => boolean,
  delivery: UserMessageDelivery,
): AgentChatItem[] {
  return items.map((it) => (it.kind === 'user' && pick(it) ? { ...it, delivery } : it));
}

/**
 * Marks queued follow-ups dropped until `total` of this run's have been marked. The endpoint
 * reports a running total (abort response `droppedFollowUps`, `tourbillon.follow_up_dropped`),
 * and the turns that did not run are always the newest queued ones.
 */
export function markDroppedFollowUps(state: AgentChatState, total: number): AgentChatState {
  let need = Math.max(0, Math.floor(total) - state.droppedThisRun);
  if (need === 0) return state;
  const items = state.items.slice();
  let marked = 0;
  for (let i = items.length - 1; i >= 0 && need > 0; i--) {
    const it = items[i];
    if (it.kind === 'user' && it.mode === 'followUp' && it.delivery === 'queued') {
      items[i] = { ...it, delivery: 'dropped' };
      need--;
      marked++;
    }
  }
  return { ...state, items, droppedThisRun: state.droppedThisRun + marked };
}

/** The run is over (RUN_FINISHED / RUN_ERROR / lost): close it out. */
export function endRun(
  state: AgentChatState,
  outcome: AgentRunOutcome,
  error: AgentChatError | null = null,
): AgentChatState {
  // Follow-ups still queued: on success they ran inside this run (the endpoint reports the ones that
  // did not, before RUN_FINISHED); otherwise they will not run. Messages still 'sending' are settled
  // by the client when their control answer arrives.
  const queuedTo: UserMessageDelivery = outcome === 'success' || outcome === 'interrupt' ? 'delivered' : 'dropped';
  let items = closeStreaming(state.items);
  items = setDelivery(items, (it) => it.delivery === 'queued', queuedTo);
  // A cancelled run the user did not stop (no Stop pressed, so not 'stopping') is reported.
  const unrequestedCancel: AgentChatError | null =
    outcome === 'cancelled' && state.status !== 'stopping' ? { kind: 'cancelled', message: RUN_CANCELLED_MESSAGE } : null;
  return {
    ...state,
    status: 'idle',
    items,
    pendingTools: outcome === 'interrupt' ? state.pendingTools : [],
    runtimeQueuedFollowUps: 0,
    droppedThisRun: 0,
    error:
      error ??
      unrequestedCancel ??
      (outcome === 'cancelled' || outcome === 'success' || outcome === 'interrupt' ? null : state.error),
    lastOutcome: outcome,
  };
}

/** Applies one event of the open run stream. */
export function applyRunEvent(state: AgentChatState, event: AguiClientEvent): AgentChatState {
  switch (event.type) {
    case 'RUN_STARTED':
      return {
        ...state,
        // A run started, so the session is no longer parked on a card.
        parked: null,
        status: state.status === 'stopping' ? 'stopping' : 'running',
        runId: str(event.runId) ?? state.runId,
        error: null,
        droppedThisRun: 0,
        items: setDelivery(state.items, (it) => it.mode === 'run' && it.delivery === 'sending', 'delivered'),
      };
    case 'TEXT_MESSAGE_START': {
      const id = str(event.messageId);
      return id ? upsertItem(state, { kind: 'assistant', id, text: '', streaming: true }) : state;
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const id = str(event.messageId);
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return state;
      const s = upsertItem(state, { kind: 'assistant', id, text: '', streaming: true });
      return updateItem(s, id, 'assistant', (it) => ({ ...it, text: it.text + delta }));
    }
    case 'TEXT_MESSAGE_END': {
      const id = str(event.messageId);
      return id ? updateItem(state, id, 'assistant', (it) => ({ ...it, streaming: false })) : state;
    }
    case 'REASONING_MESSAGE_START': {
      const id = str(event.messageId);
      return id ? upsertItem(state, { kind: 'reasoning', id, text: '', streaming: true }) : state;
    }
    case 'REASONING_MESSAGE_CONTENT': {
      const id = str(event.messageId);
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return state;
      const s = upsertItem(state, { kind: 'reasoning', id, text: '', streaming: true });
      return updateItem(s, id, 'reasoning', (it) => ({ ...it, text: it.text + delta }));
    }
    case 'REASONING_MESSAGE_END': {
      const id = str(event.messageId);
      return id ? updateItem(state, id, 'reasoning', (it) => ({ ...it, streaming: false })) : state;
    }
    case 'TOOL_CALL_START': {
      const id = str(event.toolCallId);
      if (!id) return state;
      const parentMessageId = str(event.parentMessageId);
      return upsertItem(state, {
        kind: 'tool',
        id,
        name: str(event.toolCallName) ?? 'tool',
        argsText: '',
        status: 'streaming_args',
        ...(parentMessageId ? { parentMessageId } : {}),
      });
    }
    case 'TOOL_CALL_ARGS': {
      const id = str(event.toolCallId);
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return state;
      return updateItem(state, id, 'tool', (it) => ({ ...it, argsText: it.argsText + delta }));
    }
    case 'TOOL_CALL_END': {
      const id = str(event.toolCallId);
      if (!id) return state;
      return updateItem(state, id, 'tool', (it) =>
        it.status === 'streaming_args' ? { ...it, status: 'running' } : it,
      );
    }
    case 'TOOL_CALL_RESULT': {
      const id = str(event.toolCallId);
      if (!id) return state;
      const meta = (event.metadata ?? {}) as { isError?: unknown; denied?: unknown };
      const status: ToolCallStatus = meta.denied === true ? 'denied' : meta.isError === true ? 'error' : 'done';
      const content = typeof event.content === 'string' ? event.content : '';
      const s = updateItem(state, id, 'tool', (it) => ({ ...it, status, result: content }));
      return {
        ...s,
        pendingTools: s.pendingTools.filter((p) => p.toolCallId !== id),
        parked: s.parked?.toolCallId === id ? null : s.parked,
      };
    }
    case 'CUSTOM':
      return applyCustom(state, event);
    case 'RUN_FINISHED': {
      const outcome = (event.outcome ?? {}) as { type?: unknown };
      const type =
        outcome.type === 'cancelled' ? 'cancelled' : outcome.type === 'interrupt' ? 'interrupt' : 'success';
      return endRun(state, type);
    }
    case 'RUN_ERROR':
      return endRun(state, 'error', {
        kind: 'run',
        message: str(event.message) ?? 'Agent run failed',
      });
    default:
      // STATE_*, MESSAGES_SNAPSHOT, STEP_*, REASONING_START/END: not used by this endpoint's client yet.
      return state;
  }
}

function applyCustom(state: AgentChatState, event: AguiClientEvent): AgentChatState {
  const value = (event.value ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case AGUI_CLIENT_CUSTOM.toolApprovalRequired:
    case AGUI_CLIENT_CUSTOM.toolSuspended: {
      const toolCallId = str(value.toolCallId);
      if (!toolCallId) return state;
      const reason = event.name === AGUI_CLIENT_CUSTOM.toolApprovalRequired ? 'tool_approval' : 'tool_suspended';
      const s = updateItem(state, toolCallId, 'tool', (it) => ({
        ...it,
        status: reason === 'tool_approval' ? 'awaiting_approval' : 'suspended',
      }));
      return {
        ...s,
        pendingTools: [
          ...s.pendingTools.filter((p) => p.toolCallId !== toolCallId),
          { toolCallId, toolName: str(value.toolName) ?? 'tool', reason, args: value.args ?? null },
        ],
      };
    }
    case AGUI_CLIENT_CUSTOM.followUpQueued:
      return { ...state, runtimeQueuedFollowUps: typeof value.count === 'number' ? value.count : 0 };
    case AGUI_CLIENT_CUSTOM.followUpDropped:
      return typeof value.count === 'number' ? markDroppedFollowUps(state, value.count) : state;
    default:
      return state;
  }
}

export type WidgetSendPhase = 'sending' | 'sent' | 'failed';

/** WID-3: records the send state of a widget answer / dismissal on its tool item. */
export function setWidgetSend(state: AgentChatState, toolCallId: string, phase: WidgetSendPhase): AgentChatState {
  return updateItem(state, toolCallId, 'tool', (it) => ({
    ...it,
    widgetSend: { phase, attempts: (it.widgetSend?.attempts ?? 0) + (phase === 'failed' ? 1 : 0) },
  }));
}

function parkedFrom(value: unknown, threadId: string): ParkedWidget | null {
  const v = value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return null;
  const thread = str(v.threadId);
  const toolCallId = str(v.toolCallId);
  const toolName = str(v.toolName);
  if (!thread || !toolCallId || !toolName) return null;
  const label = str(v.label);
  return { threadId: thread, toolCallId, toolName, ...(label ? { label } : {}), elsewhere: thread !== threadId };
}

/** WID-3: reads the `pendingWidget` of a refused send (409 body) for the chat on `threadId`. */
export function parkedWidgetFromBody(body: unknown, threadId: string): ParkedWidget | null {
  return parkedFrom((body as { pendingWidget?: unknown } | null | undefined)?.pendingWidget, threadId);
}

/** WID-3: records the card the session's run is parked on (null: not parked). */
export function setParked(state: AgentChatState, parked: ParkedWidget | null): AgentChatState {
  return { ...state, parked };
}

/**
 * WID-3: shows again the cards still waiting on this chat's thread (endpoint `pending` action), e.g.
 * after a reload: each becomes a suspended tool item the user can answer or dismiss. Cards already
 * shown are marked suspended again unless they have a result; `parked` is replaced by the reported one.
 */
export function restorePendingWidgets(
  state: AgentChatState,
  value: { widgets?: unknown; parked?: unknown },
  threadId: string,
): AgentChatState {
  let s = state;
  const widgets = Array.isArray(value.widgets) ? value.widgets : [];
  for (const raw of widgets) {
    const w = raw as Partial<PendingWidgetCard> | null;
    const toolCallId = str(w?.toolCallId);
    const toolName = str(w?.toolName);
    const args = w?.args;
    if (!toolCallId || !toolName || !args || typeof args !== 'object' || Array.isArray(args)) continue;
    const existing = s.items.find((it) => it.kind === 'tool' && it.id === toolCallId) as
      | Extract<AgentChatItem, { kind: 'tool' }>
      | undefined;
    if (existing && existing.result !== undefined) continue;
    s = existing
      ? updateItem(s, toolCallId, 'tool', (it) => ({ ...it, status: 'suspended' }))
      : {
          ...s,
          items: [...s.items, { kind: 'tool', id: toolCallId, name: toolName, argsText: JSON.stringify(args), status: 'suspended' }],
        };
    s = {
      ...s,
      pendingTools: [
        ...s.pendingTools.filter((p) => p.toolCallId !== toolCallId),
        { toolCallId, toolName, reason: 'tool_suspended', args },
      ],
    };
  }
  return { ...s, parked: parkedFrom(value.parked, threadId) };
}

/**
 * P0 (agent switch): shows the thread's persisted messages (thread-history.ts) before what this client
 * already holds. Items this client already has (same kind and id, e.g. a run that started before the
 * history arrived) are kept as they are; the rest of the state is unchanged.
 */
export function seedHistory(state: AgentChatState, history: readonly AgentChatItem[]): AgentChatState {
  if (history.length === 0) return state;
  const have = new Set(state.items.map((it) => `${it.kind}\u0000${it.id}`));
  const earlier = history.filter((it) => !have.has(`${it.kind}\u0000${it.id}`));
  if (earlier.length === 0) return state;
  return { ...state, items: [...earlier, ...state.items] };
}

/**
 * WID-3: the parked run was stopped (or was no longer running): its cards on this thread no longer
 * take an answer. They stay shown, locked; `parked` is cleared.
 */
export function releaseParkedWidgets(state: AgentChatState): AgentChatState {
  const parkedHere = state.parked && !state.parked.elsewhere ? state.parked.toolCallId : undefined;
  const ids = new Set(state.pendingTools.filter((p) => p.reason === 'tool_suspended').map((p) => p.toolCallId));
  if (parkedHere) ids.add(parkedHere);
  return {
    ...state,
    parked: null,
    pendingTools: state.pendingTools.filter((p) => !ids.has(p.toolCallId)),
    items: state.items.map((it) =>
      it.kind === 'tool' && ids.has(it.id) && it.status === 'suspended' ? { ...it, status: 'stopped' } : it,
    ),
  };
}
