/**
 * AGUI-1b: client state machine for POST /api/agui/[agentId] (the AGUI-1 endpoint).
 *
 * One client per (agent, thread). It matches the endpoint's run model:
 * - `send()` while idle starts a run (action `run`); the response is the run's SSE stream, read until
 *   RUN_FINISHED / RUN_ERROR. A stream that ends without either is a lost connection (`disconnected`).
 * - `send()` while a run is open sends a follow-up (action `followUp`). The endpoint queues it on the
 *   open run and answers with a short control stream (`tourbillon.control` `{ accepted, queued }`); the
 *   turn then streams on the open run. Follow-ups that will not run are reported by the endpoint
 *   (`tourbillon.follow_up_dropped` / abort `droppedFollowUps`) and marked `dropped` here.
 * - `steer()` redirects the open run (action `steer`); `abort()` asks the endpoint to stop it (action
 *   `abort`) and falls back to closing the stream (the endpoint aborts the run on disconnect) if the
 *   abort is refused or the run does not end in time.
 * - `respondToTool()` sends a tool approval decision (action `toolApproval`).
 * - 409s: control requests answered "retry shortly" (the run is still being claimed) are retried a
 *   few times; any other 409 (another run or session holds the thread) is surfaced as a `conflict`
 *   error and the message is kept as `failed` so the UI can offer it again.
 * - A response to a control request can also be a full run (a follow-up / steer reaching an idle
 *   session starts a turn); it is detected from the first events and adopted as the open run.
 *
 * WID-1 seam: `tools` (frontend tool definitions sent as RunAgentInput.tools) and `onRunEvent` (every
 * run event after the state update).
 * WID-3: `answerWidget()` / `dismissWidget()` answer a suspended widget call with an AG-UI `resume`
 * entry; the endpoint validates the answer and resumes the run on a new stream, which is adopted here.
 */
import type { ChatDashboardContext } from '@/lib/chat/dashboard-context';
import { readAguiEvents, type AguiClientEvent } from './sse';
import {
  AGUI_CLIENT_CUSTOM,
  applyRunEvent,
  endRun,
  initialAgentChatState,
  markDroppedFollowUps,
  setWidgetSend,
  TOOL_DETACHED_MESSAGE,
  type AgentChatError,
  type AgentChatItem,
  type AgentChatState,
} from './chat-state';

export type AguiAction = 'run' | 'steer' | 'followUp' | 'abort' | 'toolApproval';

/** AG-UI tool definition (RunAgentInput.tools). */
export interface AguiTool {
  name: string;
  description: string;
  parameters?: unknown;
}

export interface AgentChatClientOptions {
  /** Agent id or url key, as in /api/agui/[agentId]. */
  agentId: string;
  /** Mastra memory thread id (from the assistant thread API; the endpoint never creates one). */
  threadId: string;
  resourceId?: string;
  sessionScope?: string;
  context?: ChatDashboardContext;
  /** Defaults to `/api/agui/<agentId>`. */
  endpoint?: string;
  fetch?: typeof fetch;
  /** WID-1 seam: frontend tools sent with each run. */
  tools?: AguiTool[];
  /** WID-1 seam: called for every event of the open run, after the state update. */
  onRunEvent?: (event: AguiClientEvent) => void;
  newId?: () => string;
  /** Retries for control requests answered 409 "retry shortly". */
  retry?: { attempts: number; delayMs: number };
  /** After an accepted abort, how long to wait for the run to end before closing the stream. */
  abortTimeoutMs?: number;
}

/** AG-UI `resume` entry (RunAgentInput.resume). */
export interface AguiResumeInput {
  interruptId: string;
  status: 'resolved' | 'cancelled';
  payload?: unknown;
}

/** Shown when a widget answer reaches a card that is no longer waiting (answered elsewhere or ended). */
export const WIDGET_NOT_PENDING_MESSAGE = 'This card is no longer waiting for an answer.';

export type AgentChatResult =
  | { ok: true; value?: Record<string, unknown> }
  | { ok: false; error: AgentChatError };

class RequestFailed extends Error {
  constructor(readonly error: AgentChatError) {
    super(error.message);
  }
}

interface OpenRun {
  token: number;
  ac: AbortController;
  runId: string;
  done: Promise<void>;
  /** Set when this client closed the stream itself (abort fallback / dispose). */
  closedLocally?: 'abort' | 'dispose' | 'superseded';
}

type Decision = { mode: 'control'; value: Record<string, unknown> } | { mode: 'run' } | { mode: 'empty' };

const RETRY_SHORTLY = /retry shortly/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status})`;
}

export class AgentChatClient {
  private state: AgentChatState = initialAgentChatState;
  private readonly listeners = new Set<() => void>();
  private readonly opts: AgentChatClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private active: OpenRun | null = null;
  private starting: Promise<unknown> | null = null;
  private tokens = 0;
  private disposed = false;

  constructor(opts: AgentChatClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.newId = opts.newId ?? defaultId;
  }

  // ---- store ----

  getState = (): AgentChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: AgentChatState) {
    if (this.disposed || next === this.state) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  private update(fn: (s: AgentChatState) => AgentChatState) {
    this.set(fn(this.state));
  }

  private setItem(id: string, patch: Partial<Extract<AgentChatItem, { kind: 'user' }>>) {
    this.update((s) => ({
      ...s,
      items: s.items.map((it) => (it.kind === 'user' && it.id === id ? { ...it, ...patch } : it)),
    }));
  }

  /** Resolves once no run stream is open for this client. */
  async whenIdle(): Promise<void> {
    for (;;) {
      if (this.starting) await this.starting.catch(() => {});
      const run = this.active;
      if (!run) return;
      await run.done;
      if (this.active === run) return;
    }
  }

  get isRunOpen(): boolean {
    return this.active !== null;
  }

  // ---- actions ----

  /** Starts a run when idle; sends a follow-up while a run is open. */
  async send(text: string): Promise<AgentChatResult> {
    const message = text.trim();
    if (!message) return this.fail({ kind: 'rejected', message: 'Message is empty' });
    if (this.disposed) return this.fail({ kind: 'rejected', message: 'Chat closed' });
    if (this.starting) await this.starting.catch(() => {});
    if (this.active) return this.control('followUp', message);

    const itemId = this.newId();
    this.update((s) => ({
      ...s,
      status: 'starting',
      error: null,
      items: [...s.items, { kind: 'user', id: itemId, text: message, mode: 'run', delivery: 'sending' }],
    }));
    const start = (async (): Promise<AgentChatResult> => {
      try {
        const { res, ac, runId } = await this.post('run', message);
        this.openRun(res, ac, runId, []);
        return { ok: true };
      } catch (err) {
        const error = this.toError(err);
        this.setItem(itemId, { delivery: 'failed' });
        this.update((s) => ({ ...s, status: 'idle', error }));
        return { ok: false, error };
      }
    })();
    this.starting = start;
    try {
      return await start;
    } finally {
      if (this.starting === start) this.starting = null;
    }
  }

  /** Redirects the open run with a new instruction; starts a run when idle. */
  async steer(text: string): Promise<AgentChatResult> {
    const message = text.trim();
    if (!message) return this.fail({ kind: 'rejected', message: 'Message is empty' });
    if (this.starting) await this.starting.catch(() => {});
    if (!this.active) return this.send(message);
    return this.control('steer', message);
  }

  /** Stops the open run. */
  async abort(): Promise<AgentChatResult> {
    if (this.starting) await this.starting.catch(() => {});
    const run = this.active;
    if (!run) return { ok: true, value: { accepted: false } };
    this.update((s) => ({ ...s, status: 'stopping' }));
    const result = await this.control('abort');
    if (this.active !== run) return result; // ended meanwhile
    if (result.ok && result.value?.accepted === true) {
      const dropped = result.value.droppedFollowUps;
      if (typeof dropped === 'number') this.update((s) => markDroppedFollowUps(s, dropped));
      const timeout = this.opts.abortTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        if (this.active === run) this.closeRun(run, 'abort');
      }, timeout);
      void run.done.finally(() => clearTimeout(timer));
      return result;
    }
    // Refused or failed: close the stream; the endpoint aborts the run when its client goes away.
    this.closeRun(run, 'abort');
    return result.ok ? { ok: true, value: { ...result.value, closedStream: true } } : result;
  }

  /** Approves or declines a pending tool call. */
  async respondToTool(toolCallId: string, approved: boolean): Promise<AgentChatResult> {
    const result = await this.control('toolApproval', undefined, { toolCallId, approved });
    if (!result.ok) return result;
    const r = (result.value?.results as Array<{ toolCallId: string; accepted: boolean; reason?: string }>) ?? [];
    const mine = r.find((x) => x.toolCallId === toolCallId);
    if (result.value?.accepted === true && mine?.accepted !== false) {
      // With no run stream open here (the run ended with an interrupt), nothing will report the
      // tool's progress or result to this client: say so instead of showing it as running.
      const detached = approved && !this.active;
      this.update((s) => ({
        ...s,
        pendingTools: s.pendingTools.filter((p) => p.toolCallId !== toolCallId),
        items: s.items.map((it) =>
          it.kind === 'tool' && it.id === toolCallId
            ? { ...it, status: !approved ? 'denied' : detached ? 'detached' : 'running' }
            : it,
        ),
        ...(detached ? { error: { kind: 'detached', message: TOOL_DETACHED_MESSAGE } } : {}),
      }));
      return result;
    }
    const error: AgentChatError = {
      kind: 'rejected',
      message: `Tool decision not applied (${mine?.reason ?? 'not_pending'})`,
    };
    this.update((s) => ({ ...s, error }));
    return { ok: false, error };
  }

  /** WID-3: answers a suspended widget call; the endpoint validates it and resumes the run. */
  answerWidget(toolCallId: string, answer: unknown): Promise<AgentChatResult> {
    return this.resumeWidget({ interruptId: toolCallId, status: 'resolved', payload: { answer } });
  }

  /** WID-3: dismisses a suspended widget call; the run resumes with a dismissed result. */
  dismissWidget(toolCallId: string): Promise<AgentChatResult> {
    return this.resumeWidget({ interruptId: toolCallId, status: 'cancelled' });
  }

  private async resumeWidget(entry: AguiResumeInput): Promise<AgentChatResult> {
    const id = entry.interruptId;
    if (this.disposed) return this.fail({ kind: 'rejected', message: 'Chat closed' });
    if (this.starting) await this.starting.catch(() => {});
    this.update((s) => setWidgetSend({ ...s, error: null }, id, 'sending'));
    // No `action`: a `resume` entry is the decision (the endpoint reads it as toolApproval).
    const result = await this.control('toolApproval', undefined, undefined, [entry]);
    if (!result.ok) {
      this.update((s) => setWidgetSend(s, id, 'failed'));
      return result;
    }
    if (result.value?.startedRun === true) {
      this.update((s) => ({
        ...setWidgetSend(s, id, 'sent'),
        pendingTools: s.pendingTools.filter((p) => p.toolCallId !== id),
      }));
      return result;
    }
    // Answered with a control result: nothing was resumed (e.g. already answered elsewhere).
    const error: AgentChatError = { kind: 'rejected', message: WIDGET_NOT_PENDING_MESSAGE };
    this.update((s) => ({ ...setWidgetSend(s, id, 'failed'), error }));
    return { ok: false, error };
  }

  /** Clears the last error (e.g. after the user dismisses it). */
  clearError(): void {
    this.update((s) => (s.error ? { ...s, error: null } : s));
  }

  /** Closes the client. An open run stream is closed, which stops the run on the endpoint. */
  dispose(): void {
    if (this.disposed) return;
    const run = this.active;
    if (run) {
      run.closedLocally = 'dispose';
      run.ac.abort();
    }
    this.active = null;
    this.disposed = true;
    this.listeners.clear();
  }

  // ---- internals ----

  private fail(error: AgentChatError): AgentChatResult {
    return { ok: false, error };
  }

  private toError(err: unknown): AgentChatError {
    if (err instanceof RequestFailed) return err.error;
    return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
  }

  /** RunAgentInput for one request (the endpoint reads the last user message only). */
  buildInput(action: AguiAction, message?: string, extra: Record<string, unknown> = {}, resume?: AguiResumeInput[]) {
    const { resourceId, sessionScope, context } = this.opts;
    const runId = this.newId();
    return {
      threadId: this.opts.threadId,
      runId,
      state: {},
      messages: message !== undefined ? [{ id: this.newId(), role: 'user' as const, content: message }] : [],
      tools: this.opts.tools ?? [],
      context: [],
      ...(resume ? { resume } : {}),
      forwardedProps: {
        tourbillon: {
          // With `resume` entries the action is implied (and an explicit toolApproval would add a decision).
          ...(resume ? {} : { action }),
          ...(resourceId ? { resourceId } : {}),
          ...(sessionScope ? { sessionScope } : {}),
          ...(context ? { context } : {}),
          ...extra,
        },
      },
    };
  }

  private async post(action: AguiAction, message?: string, extra?: Record<string, unknown>, resume?: AguiResumeInput[]) {
    const endpoint = this.opts.endpoint ?? `/api/agui/${encodeURIComponent(this.opts.agentId)}`;
    const attempts = action === 'run' ? 0 : (this.opts.retry?.attempts ?? 3);
    const delayMs = this.opts.retry?.delayMs ?? 300;
    for (let attempt = 0; ; attempt++) {
      const input = this.buildInput(action, message, extra, resume);
      const ac = new AbortController();
      let res: Response;
      try {
        res = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(input),
          signal: ac.signal,
        });
      } catch (err) {
        throw new RequestFailed({ kind: 'network', message: err instanceof Error ? err.message : String(err) });
      }
      if (res.ok && res.body) return { res, ac, runId: input.runId };
      if (res.ok) throw new RequestFailed({ kind: 'network', message: 'Empty response from the agent' });
      const msg = await errorMessage(res);
      if (res.status === 409 && RETRY_SHORTLY.test(msg) && attempt < attempts && !this.disposed) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw new RequestFailed({ kind: res.status === 409 ? 'conflict' : 'http', message: msg, status: res.status });
    }
  }

  /** Sends a control action; a response that turns out to be a run is adopted as the open run. */
  private async control(
    action: Exclude<AguiAction, 'run'>,
    message?: string,
    extra?: Record<string, unknown>,
    resume?: AguiResumeInput[],
  ): Promise<AgentChatResult> {
    const itemId = message !== undefined ? this.newId() : null;
    if (itemId && message !== undefined) {
      const mode = action === 'steer' ? 'steer' : 'followUp';
      this.update((s) => ({
        ...s,
        items: [...s.items, { kind: 'user', id: itemId, text: message, mode, delivery: 'sending' }],
      }));
    }
    let decision: Decision;
    try {
      const { res, ac, runId } = await this.post(action, message, extra, resume);
      decision = await this.readDecision(res, ac, runId);
    } catch (err) {
      const error = this.toError(err);
      if (itemId) this.setItem(itemId, { delivery: 'failed' });
      if (action === 'abort' && this.state.status === 'stopping' && this.active) {
        this.update((s) => ({ ...s, status: 'running' }));
      }
      this.update((s) => ({ ...s, error }));
      return { ok: false, error };
    }
    if (decision.mode === 'run') {
      if (itemId) this.setItem(itemId, { delivery: 'delivered', mode: 'run' });
      return { ok: true, value: { accepted: true, startedRun: true } };
    }
    if (decision.mode === 'empty') {
      const error: AgentChatError = { kind: 'network', message: 'No answer from the agent' };
      if (itemId) this.setItem(itemId, { delivery: 'failed' });
      this.update((s) => ({ ...s, error }));
      return { ok: false, error };
    }
    const value = decision.value;
    if (itemId) {
      const accepted = value.accepted === true;
      const delivery = !accepted ? 'failed' : action === 'steer' ? 'delivered' : 'queued';
      // Already over (the open run ended before this answer arrived): a queued follow-up was dropped
      // by the endpoint and reported on that run; nothing else will report it.
      this.setItem(itemId, { delivery: delivery === 'queued' && !this.active ? 'dropped' : delivery });
    }
    return { ok: true, value };
  }

  /**
   * Reads the first events of a response: a control stream (RUN_STARTED, tourbillon.control,
   * RUN_FINISHED) resolves with its value; anything else is a run and is adopted.
   */
  private readDecision(res: Response, ac: AbortController, runId: string): Promise<Decision> {
    return new Promise<Decision>((resolve, reject) => {
      const held: AguiClientEvent[] = [];
      let decided: Decision | null = null;
      let adopted: ((e: AguiClientEvent) => void) | null = null;
      const body = res.body!;
      const reading = readAguiEvents(body, (ev) => {
        if (adopted) return adopted(ev);
        if (decided) return; // rest of a control stream
        if (ev.type === 'RUN_STARTED' && held.length === 0) {
          held.push(ev);
          return;
        }
        if (ev.type === 'CUSTOM' && ev.name === AGUI_CLIENT_CUSTOM.control) {
          decided = { mode: 'control', value: (ev.value ?? {}) as Record<string, unknown> };
          resolve(decided);
          return;
        }
        decided = { mode: 'run' };
        adopted = this.adoptRun(ac, runId, reading, [...held, ev]);
        resolve(decided);
      });
      reading.then(
        () => {
          if (!decided) resolve({ mode: 'empty' });
        },
        (err) => {
          if (!decided) reject(new RequestFailed({ kind: 'network', message: String(err?.message ?? err) }));
        },
      );
    });
  }

  /** Run response for action `run`: read it as the open run. */
  private openRun(res: Response, ac: AbortController, runId: string, held: AguiClientEvent[]) {
    let push: ((e: AguiClientEvent) => void) | null = null;
    const pending: AguiClientEvent[] = [];
    const reading = readAguiEvents(res.body!, (ev) => (push ? push(ev) : pending.push(ev)));
    push = this.adoptRun(ac, runId, reading, [...held, ...pending]);
  }

  /** Makes a response stream the open run; returns the per-event handler for the rest of it. */
  private adoptRun(
    ac: AbortController,
    runId: string,
    reading: Promise<void>,
    first: AguiClientEvent[],
  ): (e: AguiClientEvent) => void {
    const previous = this.active;
    if (previous) {
      // A new run was accepted, so the endpoint no longer holds the old one; detach it without
      // closing it (closing would stop the session's current run, i.e. the new one).
      previous.closedLocally = 'superseded';
    }
    const token = ++this.tokens;
    let terminal = false;
    const run: OpenRun = { token, ac, runId, done: Promise.resolve() };
    this.active = run;
    const onEvent = (ev: AguiClientEvent) => {
      if (this.active !== run || terminal || run.closedLocally) return;
      if (ev.type === 'RUN_FINISHED' || ev.type === 'RUN_ERROR') terminal = true;
      this.update((s) => applyRunEvent(s, ev));
      try {
        this.opts.onRunEvent?.(ev);
      } catch {
        /* a listener must not break the stream */
      }
      if (terminal) this.active = null;
    };
    run.done = reading.then(
      () => this.finishRun(run, terminal),
      () => this.finishRun(run, terminal),
    );
    for (const ev of first) onEvent(ev);
    return onEvent;
  }

  private finishRun(run: OpenRun, sawTerminal: boolean) {
    if (sawTerminal || run.closedLocally) return; // ended normally, closed here, or superseded
    if (this.active === run) this.active = null;
    if (this.active !== null) return; // superseded by a newer run
    this.update((s) =>
      endRun(s, 'disconnected', { kind: 'disconnected', message: 'The connection to the agent was lost' }),
    );
  }

  /** Closes the open run stream from this side (the endpoint aborts the run and drops queued turns). */
  private closeRun(run: OpenRun, why: 'abort') {
    if (run.closedLocally) return;
    run.closedLocally = why;
    if (this.active === run) this.active = null;
    run.ac.abort();
    this.update((s) => endRun(s, 'cancelled'));
  }
}

export function createAgentChatClient(opts: AgentChatClientOptions): AgentChatClient {
  return new AgentChatClient(opts);
}
