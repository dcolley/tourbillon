/**
 * AGUI-1b: client-side state for one AG-UI agent chat thread, as a pure reducer over the events the
 * AG-UI endpoint sends (lib/agui/session-events.ts) plus the client's own actions. No React here;
 * see agent-chat-client.ts for the run / control state machine and components/assistant/* for the UI.
 */
import type { AguiClientEvent } from './sse';
import { classifySendError } from './send-error';

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
  | 'failed'
  /**
   * TB-364: a later user message that waits behind a failed message (head-of-line, PM Q1).
   * Renders "runs after the current reply" — distinct from `queued` (a live follow-up).
   */
  | 'waiting'
  /** TB-364: a Retry attempt is in flight for this message (same item, same key). */
  | 'retrying'
  /** TB-364 (PM Q2): the user chose not to retry; stays in the thread, greyed "Not sent",
   * never retried, excluded from model context. */
  | 'discarded';

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

/**
 * DM-2: `at` is a client-side display timestamp (a reloaded message's stored `createdAt`). It only
 * positions DM chips in the transcript; it never joins a message sent to the model.
 */
/**
 * TB-363: a task-progress notice (Run Task transition surfaced by the runner/tool fan-out).
 * Its OWN kind — never `tool`, never `reasoning`, never folded into an assistant text bubble —
 * so a chat-detail filter that hides tool/reasoning can never hide a status notice (#344 A6).
 * `stage` is the transition word (started / done / waiting_on_user / needs_review / failed);
 * `text` is the notice line (title + stage, ask/reason when the event carries one).
 */
export interface TaskNoticeItem {
  kind: 'notice';
  id: string;
  noticeKind: 'task-progress';
  stage: string;
  text: string;
  taskId?: string;
  runId?: string;
  at?: string;
}

/**
 * TB-364: the failure recorded on a user message that failed (server marker or live RUN_ERROR).
 * Friendly copy only in the default view; `technical` is redacted + bounded (A25/A26).
 */
export interface MessageFailure {
  category: string;
  retryable: boolean;
  retryAfterMs?: number;
  friendly: { title: string; hint: string };
  /** Redacted, length-bounded raw text; NOT shown unless the details toggle is opened. */
  technical: string;
  /** A20/A36: assistant text streamed and/or a tool ran before the failure. */
  partial?: boolean;
  /** A20 (PM Q7): a tool already executed — the copy must warn and auto-retry is barred. */
  toolRan?: boolean;
  /** A21: the friendly copy should state a >60 s wait instead of retrying now. */
  longWaitMs?: number;
  /** A2/A29: the server's own failure marker set this — it wins over any client-side guess. */
  fromServer?: boolean;
}

export type AgentChatItem =
  | {
      kind: 'user';
      id: string;
      text: string;
      mode: 'run' | 'followUp' | 'steer';
      delivery: UserMessageDelivery;
      at?: string;
      /**
       * TB-364 (A5): the idempotency key, generated ONCE per message by the client when the
       * item is created, reused on every attempt, retry, backoff and reload; stored with the
       * message server-side. Never regenerated.
       */
      clientMessageId?: string;
      /** TB-364 (A21/A23): failed attempts so far (server marker is the truth across reloads). */
      attempts?: number;
      /** TB-364 (A21): epoch ms of the next scheduled automatic attempt, when one is pending. */
      nextRetryAt?: number;
      /** TB-364: the classified failure behind a `failed` delivery. */
      failure?: MessageFailure;
    }
  | TaskNoticeItem
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; at?: string; partial?: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean; at?: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      argsText: string;
      status: ToolCallStatus;
      result?: string;
      parentMessageId?: string;
      at?: string;
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
  /**
   * TB-364 (A9): the failed message is kept in the thread (greyed, Retry offered) — the composer
   * must not restore the text as well. Refusals where nothing was stored leave this unset/false.
   */
  inThread?: boolean;
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
  /**
   * STREAM-1: catching up after the page came back (history reload + re-attach to an open run). Brief;
   * the chat stays usable.
   */
  reconnecting?: boolean;
  /** CHAT-PAGE-1: the transcript pager (older stored messages not shown yet). */
  history: TranscriptHistoryState;
  /**
   * TB-364 (A1/A29): the user item the CURRENT client-started run is answering (set by
   * send()/retry(), cleared when the run settles). Failure marking keys off this — never off
   * "the last stored user row has no reply", so a notice row after it cannot cause a false
   * failure (A29).
   */
  currentRunItemId?: string | null;
  /**
   * CHAT-PAGE-1 (B1): ids of the user messages shown from the store (any page, seeded or merged).
   * These are never this client's own pending sends, so `mergeHistory` does not text-match them
   * against newly stored messages (an older paged-out message with the same text must stay).
   */
  storedUserIds?: ReadonlySet<string>;
}

/** CHAT-PAGE-1: what "Load previous" needs: whether older messages exist, and the page cursor. */
export interface TranscriptHistoryState {
  /** Older stored messages exist before the oldest one shown. */
  hasMore: boolean;
  /** Stored id of the oldest message shown (the `before` cursor of the next page); null before the first page. */
  cursor: string | null;
  /** A "Load previous" request is in flight. */
  loading: boolean;
}

export const initialTranscriptHistory: TranscriptHistoryState = { hasMore: false, cursor: null, loading: false };

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
  history: initialTranscriptHistory,
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * DM-2 (B1): the display timestamp of a live item, stamped once when it is created in this page
 * session: the run event's own `timestamp` (epoch ms) when it has one, else the client clock. Lets
 * DM chips interleave with the live tail (mergeDmTranscriptTimeline) instead of timing it as `now`.
 */
export function liveItemAt(event?: Readonly<Record<string, unknown>> | null, now: () => number = Date.now): string {
  const ts = event?.timestamp;
  const ms = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : now();
  return new Date(ms).toISOString();
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

/**
 * STREAM-1: adds the item, or (same kind and id already shown) restarts it from `item`, keeping its
 * place and any widget answer state. Used for the START events: a run re-attached after a lost stream
 * replays its events from RUN_STARTED, so each message / tool call streams again from its start.
 */
function restartItem(state: AgentChatState, item: AgentChatItem): AgentChatState {
  const i = state.items.findIndex((it) => it.id === item.id && it.kind === item.kind);
  if (i < 0) return { ...state, items: [...state.items, item] };
  const items = state.items.slice();
  const prev = items[i] as AgentChatItem & { widgetSend?: unknown };
  items[i] = {
    ...item,
    // DM-2 (B1): stamped once; a replayed START keeps the item's original place in time.
    ...(prev.at ? { at: prev.at } : {}),
    ...(prev.kind === 'tool' && prev.widgetSend ? { widgetSend: prev.widgetSend } : {}),
  } as AgentChatItem;
  return { ...state, items };
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
  // did not, before RUN_FINISHED). TB-364 (A11): when the run ENDED IN ERROR, WAS LOST, or was
  // cancelled without the user asking, they are NOT dropped — they wait (persisted, in order) and
  // run once the failed head resolves. A user-requested Stop keeps today's `dropped` report.
  const queuedTo: UserMessageDelivery =
    outcome === 'success' || outcome === 'interrupt'
      ? 'delivered'
      : outcome === 'cancelled' && state.status === 'stopping'
        ? 'dropped'
        : 'waiting';
  let items = closeStreaming(state.items, outcome);
  items = setDelivery(items, (it) => it.delivery === 'queued', queuedTo);
  // A cancelled run the user did not stop (no Stop pressed, so not 'stopping') is reported.
  const unrequestedCancel: AgentChatError | null =
    outcome === 'cancelled' && state.status !== 'stopping' ? { kind: 'cancelled', message: RUN_CANCELLED_MESSAGE } : null;
  return {
    ...state,
    status: 'idle',
    items,
    currentRunItemId: null,
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

function closeStreaming(items: AgentChatItem[], outcome: AgentRunOutcome = 'success'): AgentChatItem[] {
  const failed = outcome === 'error' || outcome === 'disconnected';
  return items.map((it) => {
    if (it.kind !== 'assistant' || !it.streaming) {
      if (it.kind === 'reasoning' && it.streaming) return { ...it, streaming: false };
      return it;
    }
    // A36 (PM Q8): a run that failed leaves its partial assistant output in place, marked
    // incomplete — it is never removed, collapsed, or replaced by the retry.
    return failed && it.text ? { ...it, streaming: false, partial: true } : { ...it, streaming: false };
  });
}

/**
 * TB-364 (A1/M1): the run errored — mark the user message it was answering `failed` (in place,
 * same item, same id), with the classified failure. Only the item the run was started for is
 * marked (no heuristics over "last user row", A29): `ownedItemId` comes from the client's own
 * `send()`/`retry()` bookkeeping. Partial-turn safety (A20): assistant text streamed after the
 * item or a tool call ran sets `partial`/`toolRan`.
 */
export function markRunItemFailed(
  state: AgentChatState,
  ownedItemId: string | null | undefined,
  failure: MessageFailure,
): AgentChatState {
  if (!ownedItemId) return state;
  const at = state.items.findIndex((it) => it.kind === 'user' && it.id === ownedItemId);
  if (at < 0) return state;
  let partial = false;
  let toolRan = false;
  for (let i = at + 1; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.kind === 'user' || it.kind === 'notice') break;
    if (it.kind === 'assistant' && it.text.trim()) partial = true;
    if (it.kind === 'tool' && it.status !== 'streaming_args') toolRan = true;
  }
  const items = state.items.slice();
  const mine = items[at] as Extract<AgentChatItem, { kind: 'user' }>;
  items[at] = {
    ...mine,
    delivery: 'failed',
    nextRetryAt: undefined,
    // A21/A23: each real failed attempt counts once (server marker is the truth across reloads).
    attempts: (mine.attempts ?? 0) + 1,
    failure: { ...failure, partial: partial || undefined, toolRan: toolRan || undefined },
  };
  return { ...state, items };
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
      // STREAM-1: a START for an item already shown (a re-attached run replays from RUN_STARTED, so
      // the message streams again from its start) restarts it instead of appending a second copy.
      const id = str(event.messageId);
      return id ? restartItem(state, { kind: 'assistant', id, text: '', streaming: true, at: liveItemAt(event) }) : state;
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const id = str(event.messageId);
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return state;
      const s = upsertItem(state, { kind: 'assistant', id, text: '', streaming: true, at: liveItemAt(event) });
      return updateItem(s, id, 'assistant', (it) => ({ ...it, text: it.text + delta }));
    }
    case 'TEXT_MESSAGE_END': {
      const id = str(event.messageId);
      return id ? updateItem(state, id, 'assistant', (it) => ({ ...it, streaming: false })) : state;
    }
    case 'REASONING_MESSAGE_START': {
      const id = str(event.messageId);
      return id ? restartItem(state, { kind: 'reasoning', id, text: '', streaming: true, at: liveItemAt(event) }) : state;
    }
    case 'REASONING_MESSAGE_CONTENT': {
      const id = str(event.messageId);
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return state;
      const s = upsertItem(state, { kind: 'reasoning', id, text: '', streaming: true, at: liveItemAt(event) });
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
      return restartItem(state, {
        kind: 'tool',
        id,
        name: str(event.toolCallName) ?? 'tool',
        argsText: '',
        status: 'streaming_args',
        ...(parentMessageId ? { parentMessageId } : {}),
        at: liveItemAt(event),
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
    case 'RUN_ERROR': {
      // TB-364 (A1/M1): the run's own message becomes `failed` in place with the classified
      // failure (server-classified fields honoured, A19); the banner shows the FRIENDLY title
      // only — the raw provider text never reaches state.error (A24).
      const message = str(event.message) ?? 'Agent run failed';
      const classified = classifySendError({
        kind: 'run',
        message,
        code: str(event.code),
        ...(typeof event.category === 'string' ? { category: event.category } : {}),
        ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
        ...(typeof event.retryAfterMs === 'number' ? { retryAfterMs: event.retryAfterMs } : {}),
      });
      const marked = markRunItemFailed(state, state.currentRunItemId, classified);
      return endRun(marked, 'error', { kind: 'run', message: classified.friendly.title });
    }
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
  const have = new Set(state.items.map(itemKey));
  const earlier = history.filter((it) => !have.has(itemKey(it)));
  const storedUserIds = withStoredUserIds(state, history);
  if (earlier.length === 0) return storedUserIds === state.storedUserIds ? state : { ...state, storedUserIds };
  return { ...state, items: [...earlier, ...state.items], storedUserIds };
}

const itemKey = (it: AgentChatItem) => `${it.kind}\u0000${it.id}`;

/** CHAT-PAGE-1 (B1): `state.storedUserIds` plus the user messages of `history` (same set when none are new). */
function withStoredUserIds(state: AgentChatState, history: readonly AgentChatItem[]): ReadonlySet<string> | undefined {
  const prev = state.storedUserIds;
  let next: Set<string> | undefined;
  for (const it of history) {
    if (it.kind !== 'user' || prev?.has(it.id) || next?.has(it.id)) continue;
    next ??= new Set(prev);
    next.add(it.id);
  }
  return next ?? prev;
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


/**
 * STREAM-1: the page came back (tab shown again, back online): shows the thread's persisted messages
 * as they are now, so anything written while the stream was lost appears in place.
 *
 * The result is the history, in order, followed by what this client holds that is not in it (a reply
 * still streaming, a message that failed to send). A message this client sent shows with its own id
 * until it is persisted; it is then replaced by its stored copy (the first newly persisted user message
 * with the same text). Only this client's own sends are matched by text: a user message shown from the
 * store (`storedUserIds`, e.g. an older page not in `history`) is never replaced (CHAT-PAGE-1 B1). Unlike `seedHistory` (chat opening, nothing shown yet), newer persisted messages
 * land after the ones already shown, not before them.
 */
export function mergeHistory(state: AgentChatState, history: readonly AgentChatItem[]): AgentChatState {
  if (history.length === 0) return state;
  const local = new Set(state.items.map(itemKey));
  const inHistory = new Set(history.map(itemKey));
  /** Persisted user messages not shown yet, by text: candidates for this client's own sends. */
  const fresh = new Map<string, number>();
  /** TB-364 (A6): stored copies of this client's keyed sends, matched by KEY, never by text. */
  const freshByKey = new Set<string>();
  /** TB-364 (A29): texts of unkeyed stored user rows that have a real reply after them. */
  const repliedStoredTexts = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    const row = history[i];
    if (row?.kind !== 'user' || row.clientMessageId) continue;
    for (let j = i + 1; j < history.length; j++) {
      const next = history[j];
      if (!next || next.kind === 'notice') continue;
      if (next.kind === 'assistant' || next.kind === 'tool') repliedStoredTexts.add(row.text);
      break;
    }
  }
  for (const it of history) {
    if (it.kind !== 'user' || local.has(itemKey(it))) continue;
    fresh.set(it.text, (fresh.get(it.text) ?? 0) + 1);
    if (it.clientMessageId) freshByKey.add(it.clientMessageId);
  }
  const stored = state.storedUserIds;
  const rest: AgentChatItem[] = [];
  for (const it of state.items) {
    if (inHistory.has(itemKey(it))) continue;
    if (it.kind === 'user' && !stored?.has(it.id)) {
      if (it.clientMessageId) {
        // A6/M8: the server kept this key (client timed out but the server stored/ran the turn):
        // the stored copy wins — a failed local item collapses to the stored one, not a second
        // bubble. Keyed items NEVER text-match (M9: two different messages with the same text
        // and different keys must stay two bubbles).
        if (freshByKey.has(it.clientMessageId)) continue;
        // A29: a stored unkeyed copy of this text HAS a real reply and the failure was only the
        // client's own stream-loss guess (no server marker) — the row is delivered; drop the
        // local failure bubble.
        if (
          (it.delivery === 'failed' || it.delivery === 'retrying') &&
          it.failure?.fromServer !== true &&
          repliedStoredTexts.has(it.text)
        ) continue;
      } else if (it.delivery !== 'failed') {
        const n = fresh.get(it.text) ?? 0;
        if (n > 0) {
          fresh.set(it.text, n - 1);
          continue;
        }
      }
    }
    rest.push(it);
  }
  // The stored copy wins, except a tool call without a stored result that this client shows waiting
  // (approval, card) or finished: that state is newer than the store's.
  const shown = new Map(state.items.map((it) => [itemKey(it), it] as const));
  const merged = history.map((it) => {
    const mine = shown.get(itemKey(it));
    if (it.kind !== 'tool' || mine?.kind !== 'tool' || it.result !== undefined) return it;
    return mine.status === 'running' || mine.status === 'streaming_args' ? it : mine;
  });
  return { ...state, items: [...merged, ...rest], storedUserIds: withStoredUserIds(state, history) };
}

/**
 * STREAM-1 × CHAT-PAGE-1: on resume only the newest page of the thread is reloaded. Shown items older
 * than that page (pages added with "Load previous", or messages that dropped out of the newest window
 * while the stream was lost) stay in front of it, in order; otherwise the merge is `mergeHistory`
 * (stored copy wins, this client's own sends are replaced by their stored copies). When none of the shown items is in the page although a page
 * was shown before (more than a page was written meanwhile), the transcript restarts at the page, with
 * this client's own undelivered sends kept, and the pager moves to it so "Load previous" fills the gap.
 */
export function mergeHistoryPage(
  state: AgentChatState,
  page: readonly AgentChatItem[],
  pager: { hasMore: boolean; cursor: string | null },
): AgentChatState {
  if (page.length === 0) return state;
  const inPage = new Set(page.map(itemKey));
  const at = state.items.findIndex((it) => inPage.has(itemKey(it)));
  if (at < 0 && state.history.cursor !== null) {
    const mine = state.items.filter((it) => it.kind === 'user' && it.delivery !== 'delivered');
    return {
      ...mergeHistory({ ...state, items: mine }, page),
      history: { hasMore: pager.hasMore, cursor: pager.cursor, loading: state.history.loading },
    };
  }
  const merged = mergeHistory(state, page);
  const history =
    state.history.cursor === null
      ? { hasMore: pager.hasMore, cursor: pager.cursor, loading: state.history.loading }
      : state.history;
  if (at <= 0) return { ...merged, history };
  // mergeHistory gives [page…, rest…]; what was shown before the page's oldest item moves back in front.
  const before = new Set(state.items.slice(0, at));
  const rest = merged.items.slice(page.length);
  const older = rest.filter((it) => before.has(it));
  const after = rest.filter((it) => !before.has(it));
  return { ...merged, items: [...older, ...merged.items.slice(0, page.length), ...after], history };
}

/**
 * STREAM-1: after the page came back, the endpoint has no open run for this chat any more (it ended
 * while the stream was lost): settle what was left running here. Follow-ups still queued here did not
 * reach the history (mergeHistory replaced the ones that ran), so they did not run.
 */
export function settleAfterResume(state: AgentChatState): AgentChatState {
  const lost = state.error?.kind === 'disconnected';
  const hasOpen = state.items.some(
    (it) => it.kind === 'user' && (it.delivery === 'queued' || it.delivery === 'retrying'),
  );
  if (state.status === 'idle' && !lost && !hasOpen) {
    return state;
  }
  let items = closeStreaming(state.items);
  // TB-364 (A11): queued follow-ups are only dropped by a user-requested Stop; after a lost/failed
  // run they WAIT (persisted, in order) and run when the head resolves. A retry whose server run
  // died while the page was away returns to `failed` with its attempts preserved (A10/A23).
  const stopRequested = state.status === 'stopping';
  items = items.map((it) => {
    if (it.kind !== 'user') return it;
    if (it.delivery === 'queued') return { ...it, delivery: stopRequested ? ('dropped' as const) : ('waiting' as const) };
    if (it.delivery === 'retrying') return { ...it, delivery: 'failed' as const, nextRetryAt: undefined };
    return it;
  });
  return {
    ...state,
    status: 'idle',
    items,
    runtimeQueuedFollowUps: 0,
    droppedThisRun: 0,
    error: lost ? null : state.error,
  };
}
