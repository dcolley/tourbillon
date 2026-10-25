/**
 * STEER-1: a steer must not make the agent forget the turn it interrupts.
 *
 * Mastra's `session.steer()` is `abort()` then `sendMessage(steer)`. The aborted run persists its
 * in-flight user message (A) only while it tears down, and that write is async (Postgres). The steer
 * run (B) loads thread history straight away, so with real storage it starts before A is saved and
 * the model only sees B. (With a synchronous in-memory store A is usually saved in time, which is why
 * stub tests never showed it.)
 *
 * `steerPreservingTurn` keeps A: it snapshots the run's in-flight user turns before the abort, saves
 * any that are not in thread storage yet (same message id as Mastra's own save, so the aborted run's
 * late write upserts the same row: no duplicate), then sends the steer. If saving fails, the missing
 * originals are carried inline in the steer message instead, so the model still gets both.
 *
 * In-flight turns are seen from the session's own events (`message_start` of a `data-user-message`
 * signal), so {@link trackInFlightUserTurns} has to be attached before the run starts; the chat
 * registry attaches it to every chat session it hands out.
 */

/** A user message the current run was started (or interjected) with. */
export interface InFlightUserTurn {
  id: string;
  threadId: string;
  contents: unknown;
  createdAt?: string;
  acceptedAt?: string;
  attributes?: SignalAttributes;
}

type SessionEvent = { type?: unknown; message?: unknown };

/** Signal attribute values Mastra accepts. */
export type SignalAttributes = Record<string, string | number | boolean | null | undefined>;

/** The slice of a Mastra AgentController Session this helper uses. */
export interface SteerableSession {
  subscribe(listener: (event: SessionEvent) => void): () => void;
  thread: {
    getId(): string | null | undefined;
    listMessages(input: { threadId: string; limit?: number }): Promise<Array<{ id?: unknown }>>;
  };
  identity: { getResourceId(): string };
  abort(): void;
  sendMessage(input: { content: string; requestContext?: never }): Promise<void>;
  sendSignalToThread(
    input: {
      id: string;
      type: 'user';
      tagName: 'user';
      contents: never;
      createdAt?: string;
      acceptedAt?: string;
      attributes?: SignalAttributes;
    },
    target: { resourceId: string; threadId: string },
  ): { accepted: Promise<unknown> };
}

export interface SteerPreservingTurnResult {
  /** In-flight user turns that were already in thread storage. */
  alreadyStored: string[];
  /** In-flight user turns this call saved before sending the steer. */
  persisted: string[];
  /** In-flight user turns that could not be saved and were carried inline in the steer message. */
  inlined: string[];
}

/** How many of the newest stored messages are checked for the in-flight turns. */
export const STEER_HISTORY_WINDOW = 50;

interface TrackerState {
  turns: InFlightUserTurn[];
}

const trackers = new WeakMap<object, TrackerState>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function signalAttributes(value: unknown): SignalAttributes | undefined {
  const r = record(value);
  if (!r) return undefined;
  const out: SignalAttributes = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v as SignalAttributes[string];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isoish(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return str(value);
}

/** User turns carried by a `message_start` event (Mastra emits each run input as a signal message). */
export function userTurnsFromEvent(event: SessionEvent, threadId: string): InFlightUserTurn[] {
  if (event.type !== 'message_start') return [];
  const message = record(event.message);
  if (!message || message.role !== 'signal') return [];
  const parts = record(message.content)?.parts;
  if (!Array.isArray(parts)) return [];
  const turns: InFlightUserTurn[] = [];
  for (const part of parts) {
    const p = record(part);
    if (p?.type !== 'data-user-message') continue;
    const data = record(p.data);
    const id = str(data?.id);
    if (!data || !id || data.type !== 'user' || data.contents === undefined) continue;
    const attributes = signalAttributes(data.attributes);
    turns.push({
      id,
      threadId,
      contents: data.contents,
      ...(isoish(data.createdAt) ? { createdAt: isoish(data.createdAt) } : {}),
      ...(isoish(data.acceptedAt) ? { acceptedAt: isoish(data.acceptedAt) } : {}),
      ...(attributes ? { attributes } : {}),
    });
  }
  return turns;
}

/**
 * Follow the user turns of the session's current run (idempotent per session). Reset at each
 * `agent_start`, so the list holds only the run a steer would abort.
 */
export function trackInFlightUserTurns(session: Pick<SteerableSession, 'subscribe' | 'thread'>): void {
  if (trackers.has(session)) return;
  const state: TrackerState = { turns: [] };
  trackers.set(session, state);
  session.subscribe((event) => {
    if (event.type === 'agent_start') {
      state.turns = [];
      return;
    }
    const threadId = session.thread.getId();
    if (!threadId) return;
    for (const turn of userTurnsFromEvent(event, threadId)) {
      if (!state.turns.some((t) => t.id === turn.id)) state.turns.push(turn);
    }
  });
}

/** Snapshot of the tracked in-flight user turns on `threadId`. */
export function inFlightUserTurns(session: object, threadId: string): InFlightUserTurn[] {
  return (trackers.get(session)?.turns ?? []).filter((t) => t.threadId === threadId).map((t) => ({ ...t }));
}

/** Plain text of a signal's contents (string, or text parts of a content array). */
export function userTurnText(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return '';
  return contents
    .map((part) => {
      const p = record(part);
      return p?.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Fallback steer text when an original could not be saved: originals first, then the steer, once each. */
export function combineOriginalAndSteer(originals: string[], steer: string): string {
  const kept = originals.map((o) => o.trim()).filter(Boolean);
  if (kept.length === 0) return steer;
  return [
    'Your previous turn was interrupted before it finished. The original request was:',
    ...kept,
    'Now, redirecting that work:',
    steer,
  ].join('\n\n');
}

async function storedIds(session: SteerableSession, threadId: string): Promise<Set<string> | undefined> {
  try {
    const messages = await session.thread.listMessages({ threadId, limit: STEER_HISTORY_WINDOW });
    return new Set(messages.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean));
  } catch {
    return undefined;
  }
}

/**
 * Steer the session's run without losing the user turn it interrupts. Drop-in for
 * `session.steer({ content, requestContext })`; resolves when the steer is delivered.
 */
export async function steerPreservingTurn(
  session: SteerableSession,
  { content, requestContext }: { content: string; requestContext?: unknown },
): Promise<SteerPreservingTurnResult> {
  trackInFlightUserTurns(session);
  const threadId = session.thread.getId();
  // Snapshot before the abort: the next run's agent_start resets the tracker.
  const inFlight = threadId ? inFlightUserTurns(session, threadId) : [];
  session.abort();

  const result: SteerPreservingTurnResult = { alreadyStored: [], persisted: [], inlined: [] };
  let steer = content;
  if (threadId && inFlight.length > 0) {
    const stored = await storedIds(session, threadId);
    const resourceId = session.identity.getResourceId();
    const inline: string[] = [];
    for (const turn of inFlight) {
      if (stored?.has(turn.id)) {
        result.alreadyStored.push(turn.id);
        continue;
      }
      try {
        await session.sendSignalToThread(
          {
            id: turn.id,
            type: 'user',
            tagName: 'user',
            contents: turn.contents as never,
            ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
            ...(turn.acceptedAt ? { acceptedAt: turn.acceptedAt } : {}),
            ...(turn.attributes ? { attributes: turn.attributes } : {}),
          },
          { resourceId, threadId },
        ).accepted;
        result.persisted.push(turn.id);
      } catch (err) {
        console.warn('[steer] could not save the interrupted user turn; sending it inline', turn.id, err);
        result.inlined.push(turn.id);
        inline.push(userTurnText(turn.contents));
      }
    }
    steer = combineOriginalAndSteer(inline, content);
  }

  await session.sendMessage({ content: steer, requestContext: requestContext as never });
  return result;
}
