/**
 * CONCIERGE-QUEUE-SIGNAL: typed reactive signals into the parent free-chat.
 *
 * Mastra's `queueSignal` (Session / Agent) queues a TYPED signal for the next thread turn —
 * same ordering as `queueMessage`, but it renders to the model as tagged XML context
 * (`<task-progress …>…</task-progress>`), never as a fake user message. Idle thread → the
 * signal starts a run immediately; active thread → it waits for the current run, then a new
 * run picks it up. That is exactly the TASK-RUNNER parent UX: high-level Run Task progress
 * (started / needs another look / done / needs a decision) reaching the concierge's free-chat
 * as a reactive signal — not tool transcripts, not user-text stuffing, and NOT a mid-token
 * `sendSignal` interrupt (product lock: routine progress is queued for the next turn).
 *
 * The helpers here are deliberately structural (duck-typed session/agent): the web process
 * owns the long-lived AgentController sessions, and the bridge that calls these lives there.
 */

// S307-S2 (#304 softs): type-only subpath import (no runtime barrel side effects) - the
// shared union keeps publisher (scheduler) and parser (web) on one status contract.
import type { TaskProgressStage, TaskProgressStatus } from '@tourbillon/shared/types';
// TB-HOTFIX-REDACT (MUST-1/MUST-2): the ONE redactor + directive stripper, applied at
// FORMAT time so no secret and no model-directed instruction ever reaches contents,
// attributes, or the persisted technical text for ANY stage.
import { redactErrorText } from '@tourbillon/shared/redact-error';

/** Tag name the free-chat concierge sees on Run Task progress signals. */
export const TASK_PROGRESS_TAG_NAME = 'task-progress';

/** Signal attribute values Mastra accepts (AgentSignalAttributes). */
export type ConciergeSignalAttributes = Record<string, string | number | boolean | null | undefined>;

/** Keep the model-side attribute bag small and printable. */
export const CONCIERGE_ATTRIBUTE_VALUE_LIMIT = 120;
export const CONCIERGE_CONTENTS_LIMIT = 500;

/** Minimal shape of Mastra's `AgentSignalInput` this helper writes. */
export interface ConciergeSignalInput {
  /** Stable id so a later dismiss/pause can cancel THIS queued signal by id. */
  id?: string;
  tagName?: string;
  attributes?: ConciergeSignalAttributes;
  contents: string;
  /** TB-363 MUST-7: delivery-only signal (wake runs, no stored row — persistence filters skip transient). */
  transient?: boolean;
}

/** The one Session method this helper needs (Mastra Session.queueSignal). */
export interface QueueSignalSession {
  queueSignal(
    signal: { type: 'reactive'; tagName?: string; attributes?: ConciergeSignalAttributes; contents: string; id?: string; transient?: boolean },
    opts?: Record<string, unknown>,
  ): Promise<void> | void;
}

/** The one Agent method the cancel path needs (Mastra Agent.cancelQueuedMessages). */
export interface QueuedSignalCancelAgent {
  cancelQueuedMessages?(target: {
    threadId: string;
    signalIds: string[];
    resourceId?: string;
  }): { cancelledSignalIds: string[] } | Promise<{ cancelledSignalIds: string[] }>;
}

/**
 * TB-363 (MUST-4): the one Agent method the persist-without-wake path needs — Mastra's PUBLIC
 * `Agent.queueSignal(signal, target)` (agent/agent.d.ts:1460), whose target accepts
 * `ifIdle.behavior: 'persist'` (thread-stream runtime: agent-DtdQ6un6.js:43813/43868 — idle
 * thread writes the signal row through Memory and starts NO run; a busy thread still gets the
 * default ifActive 'deliver'). The AgentController Session's own queueSignal cannot express
 * this: its option bag destructures only tracingContext/tracingOptions/requestContext
 * (agent-controller-…js:5723) and drops ifIdle — hence the Agent-level call.
 */
export interface PersistSignalTarget {
  resourceId: string;
  threadId: string;
}

export interface PersistSignalAgent {
  /**
   * TB-363 CONT4: `Agent.sendSignal`, NOT `queueSignal`. `queueSignal` hard-codes
   * `ifIdle.behavior:'wake'` on the idle path (agent-DtdQ6un6.js:43747), so it can never
   * persist-without-wake; `sendSignal` honours `ifIdle.behavior` (agent/agent.d.ts:1474).
   */
  sendSignal(
    signal: { type: 'reactive'; tagName?: string; attributes?: ConciergeSignalAttributes; contents: string; id?: string; transient?: boolean },
    target: {
      resourceId: string;
      threadId: string;
      ifIdle?: { behavior: 'wake' | 'persist' | 'discard' };
      ifActive?: { behavior: 'wake' | 'persist' | 'discard' };
    },
  ): {
    accepted: Promise<{ action: string; runId?: string }>;
    signal?: { id?: string };
    persisted?: Promise<void>;
  };
}

/**
 * TB-363 (MUST-4, PM Q1): persist one typed signal to the thread WITHOUT waking a model turn
 * (idle thread → `ifIdle.behavior: 'persist'`: the signal row lands in memory, zero runs).
 * Same payload normalization as queueConciergeSignal (tag name, sanitized attributes, clamped
 * contents), same id convention. Resolves after Mastra's ROUTING DECISION (`accepted`) only.
 * It deliberately does NOT await the `persisted` handle: for the idle-persist path Mastra
 * settles that promise only when the broadcast stream is consumed (agent-DtdQ6un6.js
 * #broadcastPersistedSignal — its ReadableStream start() runs on first read), so awaiting it
 * hangs forever with nobody reading; the runtime itself never awaits it either. The memory
 * write is issued synchronously by #persistAndBroadcastIdleSignal before the broadcast, so a
 * resolved `accepted` on the persist path already means the write has been dispatched.
 */
export async function persistConciergeSignal(
  agent: PersistSignalAgent,
  target: PersistSignalTarget,
  input: ConciergeSignalInput,
): Promise<{ signalId: string; action: string }> {
  const id = input.id ?? `sig-${randomId()}`;
  // TB-363 MUST-6: ifActive must be 'persist' too. Mastra's sendSignal defaults ifActive to
  // 'deliver' (agent-DtdQ6un6.js, #sendSignal: `activeBehavior = target.ifActive?.behavior ?? "deliver"`),
  // which routes a same-agent busy thread through #queueForActiveRun — the notice would drain
  // INTO the in-flight turn (a second reply mid-turn), and a cross-agent busy run returns
  // accepted.action 'blocked' (thread-blocked) with nothing persisted. Tool moves always land
  // while the origin thread is busy, so 'persist' on both sides of the idle policy is the
  // no-wake path: the row lands, zero runs start.
  const result = agent.sendSignal(
    {
      type: 'reactive',
      tagName: input.tagName ?? TASK_PROGRESS_TAG_NAME,
      attributes: sanitizeSignalAttributes(input.attributes),
      contents: clampContents(input.contents),
      id,
    },
    { ...target, ifIdle: { behavior: 'persist' }, ifActive: { behavior: 'persist' } },
  );
  const decision = await result.accepted;
  // TB-363 CONT3 root cause: never await `result.persisted` — see docstring. Swallow its
  // rejection so the unhandled promise can't crash the bridge subscriber.
  result.persisted?.catch(() => {});
  return { signalId: result.signal?.id ?? id, action: decision.action };
}

function printableAttribute(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    // TB-HOTFIX-REDACT (MUST-1 / M14): REDACT FIRST, then clamp — a secret past the bag
    // limit must never survive as a clamped prefix.
    const redacted = redactErrorText(value);
    return redacted.length > CONCIERGE_ATTRIBUTE_VALUE_LIMIT
      ? `${redacted.slice(0, CONCIERGE_ATTRIBUTE_VALUE_LIMIT - 1)}…`
      : redacted;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined; // objects/arrays never belong in the attribute bag
}

/** Drop non-printable values and clamp long strings (model-visible, keep it small). */
export function sanitizeSignalAttributes(
  attributes: Record<string, unknown> | undefined,
): ConciergeSignalAttributes {
  if (!attributes) return {};
  const out: ConciergeSignalAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const printable = printableAttribute(value);
    if (printable !== undefined) out[key] = printable;
  }
  return out;
}

function clampContents(contents: string): string {
  // TB-HOTFIX-REDACT (M14): redact BEFORE clamp — the visible prefix of a clamped
  // notice must never be a secret fragment.
  const trimmed = redactErrorText(contents).trim();
  if (trimmed.length <= CONCIERGE_CONTENTS_LIMIT) return trimmed;
  return `${trimmed.slice(0, CONCIERGE_CONTENTS_LIMIT - 1)}…`;
}

/**
 * Queue a typed reactive signal onto a free-chat session for its NEXT turn (idle → wakes the
 * thread immediately; active → waits for the current run — ordering is Mastra's, owned by the
 * shared queue). Returns the signal id for later cancellation. Never sends mid-token.
 */
export async function queueConciergeSignal(
  session: QueueSignalSession,
  input: ConciergeSignalInput,
): Promise<{ signalId: string }> {
  const id = input.id ?? `sig-${randomId()}`;
  await session.queueSignal({
    type: 'reactive',
    tagName: input.tagName ?? TASK_PROGRESS_TAG_NAME,
    attributes: sanitizeSignalAttributes(input.attributes),
    contents: clampContents(input.contents),
    id,
    // TB-363 MUST-7 (PM N-3): a covered go-between reply is delivery-only — Mastra's
    // persistence filters drop transient signals, so the wake turn runs WITHOUT storing a
    // second notice row (filter-messages-for-persistence:22274, agent-DtdQ6un6.js).
    ...(input.transient ? { transient: true } : {}),
  });
  return { signalId: id };
}

/**
 * Cancel queued concierge signals by id (user dismissed / paused the task before delivery).
 * No-op returning [] when the agent cannot cancel (older Mastra, or nothing queued).
 *
 * NOTE (#197 soft-pack S5): no production caller yet, and the bridge does not persist the
 * generated signal ids — wiring this needs a dismiss/pause UX first (deliberately not
 * invented here). Kept + tested so that hook-up is one call away when the UX lands.
 */
export async function cancelQueuedConciergeSignals(
  agent: QueuedSignalCancelAgent,
  target: { resourceId?: string; threadId: string; signalIds: string[] },
): Promise<string[]> {
  if (!agent.cancelQueuedMessages || target.signalIds.length === 0) return [];
  const result = await agent.cancelQueuedMessages({
    threadId: target.threadId,
    signalIds: target.signalIds,
    ...(target.resourceId ? { resourceId: target.resourceId } : {}),
  });
  return result.cancelledSignalIds ?? [];
}

// ─── TASK-RUNNER progress → signal payload ──────────────────────────────────

/**
 * The Run Task progress event the scheduler emits (structurally ChatTaskProgressEvent from
 * packages/scheduler task-runner — kept structural so packages/mastra never imports the
 * scheduler; the STATUS union itself is single-sourced in @tourbillon/shared, S307-S2).
 */
export interface TaskProgressEventShape {
  companyId: string;
  agentId: string;
  chatTaskId: string;
  runId: string;
  /** #339: shared single-source stage union (waiting_on_user + failed landed with the
   * scheduler publisher + web parser in the same commit). */
  stage: TaskProgressStage;
  status: TaskProgressStatus;
  /** #339: the precise ask/failure text when the scheduler carries one. */
  detail?: string;
  title: string;
  /**
   * TB-363 (MUST-4, PM Q1): who caused this transition. 'tool' = the concierge moved the task
   * itself via updateMyTask/completeMyTask — per the Q1 ruling that notice is a compact status
   * LINE, never a second chat reply, so the bridge persists it WITHOUT waking a model turn
   * (runner events leave this unset and keep the reactive wake).
   */
  source?: 'tool';
}

export interface TaskProgressSignalPayload {
  tagName: string;
  attributes: ConciergeSignalAttributes;
  contents: string;
  /**
   * TB-HOTFIX-REDACT (§2): redacted technical text for the failed notice's
   * [data-error-details] toggle body. Survives reload (persisted alongside the row),
   * is already passed through redactErrorText (cap TECHNICAL_MAX_CHARS), and is NEVER
   * stuffed unredacted into the 120-char attribute bag.
   */
  technical?: string;
  /**
   * TB-363 MUST-7 (PM N-3): delivery-only signal — the runner's go-between reply rides on it,
   * but Mastra must NOT store a second notice row (`#persistSignal` skips transient signals).
   */
  transient?: boolean;
}

/**
 * Map a Run Task transition to the parent free-chat signal payload: small attributes +
 * one short human line the model can talk about. The four product states (started / done /
 * needs another look / needs a decision): `needs_review` splits on status — a failed run
 * needs another look (it retries), a skipped one is parked and needs a human decision.
 */
export function taskProgressSignalPayload(event: TaskProgressEventShape): TaskProgressSignalPayload {
  // TB-HOTFIX-REDACT (MUST-1): title and detail arrive from the scheduler/runner and may
  // echo provider error strings (API keys, tokens, URL userinfo passwords, JWTs). REDACT
  // them BEFORE they are interpolated into contents or the attribute bag, for EVERY stage
  // (failed, waiting_on_user AND done — a secret can ride the title too).
  const title = redactErrorText(event.title.trim()) || 'untitled task';
  const detail = event.detail ? redactErrorText(event.detail) : undefined;
  let contents: string;
  let technical: string | undefined;
  switch (event.stage) {
    case 'started':
      // Neutral system voice (soft-pack S6): the signal is tagged context, not the agent's
      // own sentence — no "I will report back".
      contents = `Background task started: "${title}". Progress updates will follow.`;
      break;
    case 'done':
      contents = `Background task done: "${title}".`;
      break;
    case 'needs_review':
      contents =
        event.status === 'skipped'
          ? `Background task "${title}" is blocked and needs a decision from the human.`
          : `Background task "${title}" did not finish and needs another look.`;
      break;
    case 'waiting_on_user':
      // #339: the go-between wake — relay the STATED ask (#340 contract), never invent one.
      // TB-363 A2: the stored notice text is what the human sees, so it must also say HOW to
      // answer — a reply in this thread resumes the task (status pending, #340 contract).
      // TB-HOTFIX-REDACT (MUST-2): the model-directed instruction ("Ask them for exactly
      // that; … resume the task …") is GONE from the human-visible line — the resume path is
      // driven by the reply, not by this text. The exact ask and "reply here" stay (A2).
      contents = `Background task "${title}" is waiting on the human${
        detail ? `: ${detail}` : ''
      }. They can reply here; the task resumes (status pending) when they answer.`;
      break;
    case 'failed':
      // #340 honesty: a runner failure is a FAILURE, not a question for the human.
      // TB-HOTFIX-REDACT (MUST-2 / MUST-3): the visible line is a short friendly FAILURE
      // line — no stack, no directives, no secrets. The redacted technical text rides on the
      // payload's `technical` field and renders only behind the [data-error-details] toggle.
      contents = `Background task "${title}" FAILED. The failure reason is available in the notice's error details.`;
      technical = detail;
      break;
    default:
      contents = `Background task update for "${title}".`;
  }
  return {
    tagName: TASK_PROGRESS_TAG_NAME,
    attributes: sanitizeSignalAttributes({
      taskId: event.chatTaskId,
      runId: event.runId,
      stage: event.stage,
      status: event.status,
      // §2: a redacted (then 120-char clamped) copy in the bag so the toggle body survives
      // reload even for readers that only see attributes.
      ...(technical ? { technical } : {}),
    }),
    contents,
    ...(technical ? { technical } : {}),
  };
}

function randomId(): string {
  // crypto.randomUUID is available on every Node we support; tiny indirection for stubs.
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

// ─── TB-363 (A11 / R3): the TOOL-PATH progress publish seam ──────────────────
//
// Before this, ONLY the scheduler published `chat_task_progress` — a status move the
// concierge made itself with updateMyTask / completeMyTask (Derek's #363 repro) produced an
// audit row and NO event, so the human never saw a notice. These moves now publish exactly
// one event per real transition through this host-injected seam, using the SAME wire shape
// and the SAME event identity (companyId:chatTaskId:runId:stage = taskProgressClaimKey) as
// the runner, so the web bridge's claim collapses a tool move and the runner settle of the
// same transition into ONE notice (A11b). Hosts (apps/web instrumentation, scheduler-main /
// wake boot) inject the redis publisher; without one the transition is lost but NEVER silent
// (S3): a warn names the gap.

/** One `chat_task_progress` publish (structurally the scheduler's ChatTaskProgressEvent). */
export interface ChatTaskProgressPublishEvent {
  companyId: string;
  agentId: string;
  chatTaskId: string;
  runId: string;
  stage: TaskProgressStage;
  status: TaskProgressStatus;
  title: string;
  /** Ask/failure text, clamped to the scheduler's 300-char event cap. */
  detail?: string;
  /** TB-363 (MUST-4): 'tool' for concierge tool-driven moves — persisted, never a model wake. */
  source?: 'tool';
}

export type ChatTaskProgressPublisher = (event: ChatTaskProgressPublishEvent) => void | Promise<void>;

let chatTaskProgressPublisher: ChatTaskProgressPublisher | null = null;

/** Host wiring: called once per process (web instrumentation / scheduler boot). null = unset. */
export function setChatTaskProgressPublisher(publisher: ChatTaskProgressPublisher | null): void {
  chatTaskProgressPublisher = publisher;
}

/** Test seam: is a publisher wired? (No production caller.) */
export function getChatTaskProgressPublisher(): ChatTaskProgressPublisher | null {
  return chatTaskProgressPublisher;
}

/**
 * Publish one tool-path transition. Fire-and-forget like the scheduler publisher; a missing
 * publisher or a throwing publisher is SURFACED via console.warn (S3), never silent, and must
 * never fail the tool call that asked for it.
 */
export function publishChatTaskProgress(event: ChatTaskProgressPublishEvent): boolean {
  const clamped: ChatTaskProgressPublishEvent = event.detail
    ? { ...event, detail: event.detail.slice(0, 300) }
    : event;
  if (!chatTaskProgressPublisher) {
    console.warn('[chat-task-progress] no progress publisher wired — transition not announced', {
      chatTaskId: clamped.chatTaskId,
      stage: clamped.stage,
    });
    return false;
  }
  try {
    void Promise.resolve(chatTaskProgressPublisher(clamped)).catch((err) => {
      console.warn('[chat-task-progress] progress publish failed', {
        chatTaskId: clamped.chatTaskId,
        stage: clamped.stage,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  } catch (err) {
    console.warn('[chat-task-progress] progress publish threw', {
      chatTaskId: clamped.chatTaskId,
      stage: clamped.stage,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
