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
  | 'denied';

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
  | 'rejected';

export interface AgentChatError {
  kind: AgentChatErrorKind;
  message: string;
  status?: number;
}

export type AgentRunOutcome = 'success' | 'cancelled' | 'interrupt' | 'error' | 'disconnected';

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
  return {
    ...state,
    status: 'idle',
    items,
    pendingTools: outcome === 'interrupt' ? state.pendingTools : [],
    runtimeQueuedFollowUps: 0,
    droppedThisRun: 0,
    error: error ?? (outcome === 'cancelled' || outcome === 'success' || outcome === 'interrupt' ? null : state.error),
    lastOutcome: outcome,
  };
}

/** Applies one event of the open run stream. */
export function applyRunEvent(state: AgentChatState, event: AguiClientEvent): AgentChatState {
  switch (event.type) {
    case 'RUN_STARTED':
      return {
        ...state,
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
      return { ...s, pendingTools: s.pendingTools.filter((p) => p.toolCallId !== id) };
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
