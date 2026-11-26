/**
 * TB-364: the SERVER-side failure marker (R2: message-level metadata, never localStorage).
 *
 * The marker is what makes a failed message a fact of the thread rather than client memory:
 * it is written to storage with the message it describes and the history endpoint returns it
 * verbatim, so a fresh browser with cleared storage renders the same failed/waiting/discarded
 * state (A2, A23, A28, A35). Failure detection reads the marker only — never a
 * "last user row has no reply" heuristic (A29/M35).
 *
 * Storage shapes (R2, proven on the base):
 *  - The stored USER row keeps its marker in its own message metadata (the same bag #367 reads
 *    `metadata.signal`), keyed `tb364`: { key, state, category, retryable, attempts, technical,
 *    retryAfterMs, partial, toolRan, text }.
 *  - Two APPEND-ONLY signal rows carry what has no stored user row yet, both keyed by
 *    `clientMessageId` and never role 'user' (so they can never enter model context — A12b —
 *    and the notice guards keep them out of the transcript as user items — A29):
 *      tagName 'tb364-queue'   — a follow-up accepted into the queue but not yet run (waiting, A28)
 *      tagName 'tb364-marker'  — a marker for a row whose keyed user row is being rewritten
 *    A discarded message's OWN user row is rewritten in place (same id — the steer precedent's
 *    proven same-id upsert): its text becomes the placeholder so the model never sees it again
 *    (A35c/M50) and the original text survives in the marker's `text` field.
 *
 * REDACTION (A25b/A26): `technical` is written from `redactErrorText` only, bounded. Raw engine
 * text NEVER reaches storage, the SSE body, or logs from this module.
 */
import { redactErrorText, TECHNICAL_MAX_CHARS } from './redact-error';
import { classifySendError, type ClassifiedSendError } from './client/send-error';

export const TB364_MARKER_ATTRS = [
  'tb364Key',
  'tb364State',
  'tb364Category',
  'tb364Retryable',
  'tb364Attempts',
  'tb364Technical',
  'tb364RetryAfterMs',
  'tb364Partial',
  'tb364ToolRan',
  'tb364Text',
] as const;

export const TB364_QUEUE_TAG = 'tb364-queue';
export const TB364_MARKER_TAG = 'tb364-marker';
/** Placeholder written over a discarded message's stored text so it leaves model context (A35c). */
export const DISCARDED_PLACEHOLDER_TEXT = '[not sent — discarded]';

export type Tb364State = 'failed' | 'discarded' | 'waiting' | 'running' | 'sent';

export interface Tb364MarkerFields {
  clientMessageId: string;
  state: Tb364State;
  category?: string;
  retryable?: boolean;
  attempts?: number;
  /** REDACTED, bounded (redactErrorText) — never raw engine text. */
  technical?: string;
  retryAfterMs?: number;
  partial?: boolean;
  toolRan?: boolean;
  /** Original text, kept for rows whose stored text was replaced (discard). */
  text?: string;
}

/** Marker attribute bag for storage: prefixed keys, redacted technical, undefined keys dropped. */
export function tb364Attrs(fields: Tb364MarkerFields): Record<string, string | number | boolean> {
  const technical = fields.technical === undefined ? undefined : redactErrorText(fields.technical).slice(0, TECHNICAL_MAX_CHARS);
  const attrs: Record<string, string | number | boolean> = {
    tb364Key: fields.clientMessageId,
    tb364State: fields.state,
  };
  if (fields.category !== undefined) attrs.tb364Category = fields.category;
  if (fields.retryable !== undefined) attrs.tb364Retryable = fields.retryable;
  if (fields.attempts !== undefined) attrs.tb364Attempts = fields.attempts;
  if (technical !== undefined) attrs.tb364Technical = technical;
  if (fields.retryAfterMs !== undefined) attrs.tb364RetryAfterMs = fields.retryAfterMs;
  if (fields.partial !== undefined) attrs.tb364Partial = fields.partial;
  if (fields.toolRan !== undefined) attrs.tb364ToolRan = fields.toolRan;
  if (fields.text !== undefined) attrs.tb364Text = fields.text;
  return attrs;
}

/** Read a marker attribute bag back; null when absent or malformed (fail-safe: no marker). */
export function readTb364Attrs(attrs: unknown): Tb364MarkerFields | null {
  if (typeof attrs !== 'object' || attrs === null) return null;
  const a = attrs as Record<string, unknown>;
  const key = a.tb364Key;
  const state = a.tb364State;
  if (typeof key !== 'string' || !key) return null;
  if (state !== 'failed' && state !== 'discarded' && state !== 'waiting' && state !== 'running' && state !== 'sent') return null;
  return {
    clientMessageId: key,
    state,
    ...(typeof a.tb364Category === 'string' ? { category: a.tb364Category } : {}),
    ...(typeof a.tb364Retryable === 'boolean' ? { retryable: a.tb364Retryable } : {}),
    ...(typeof a.tb364Attempts === 'number' ? { attempts: a.tb364Attempts } : {}),
    ...(typeof a.tb364Technical === 'string' ? { technical: a.tb364Technical } : {}),
    ...(typeof a.tb364RetryAfterMs === 'number' ? { retryAfterMs: a.tb364RetryAfterMs } : {}),
    ...(typeof a.tb364Partial === 'boolean' ? { partial: a.tb364Partial } : {}),
    ...(typeof a.tb364ToolRan === 'boolean' ? { toolRan: a.tb364ToolRan } : {}),
    ...(typeof a.tb364Text === 'string' ? { text: a.tb364Text } : {}),
  };
}

/**
 * Server classification for the SSE RUN_ERROR machine fields (A19) and the marker (A2).
 * The engine text is classified BEFORE redaction (the category needs the raw signal) and the
 * technical string that leaves this function is always redacted + bounded (A26).
 */
export interface Tb364RunFailure {
  category: string;
  retryable: boolean;
  friendlyTitle: string;
  technical: string;
  retryAfterMs?: number;
  partial: boolean;
  toolRan: boolean;
}

export function classifyRunFailure(input: {
  engineText: string | undefined;
  status?: number;
  retryAfterMs?: number;
  streamedText?: boolean;
  toolStarted?: boolean;
}): Tb364RunFailure {
  const classified: ClassifiedSendError = classifySendError({
    kind: 'run',
    message: input.engineText ?? 'Agent run failed',
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
  // A20 (PM Q7): after side effects the AUTOMATIC schedule is barred regardless of class.
  const sideEffects = input.streamedText === true || input.toolStarted === true;
  return {
    category: classified.category,
    retryable: classified.retryable && !sideEffects,
    friendlyTitle: classified.friendly.title,
    technical: redactErrorText(input.engineText ?? '').slice(0, TECHNICAL_MAX_CHARS),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    partial: sideEffects,
    toolRan: input.toolStarted === true,
  };
}

/**
 * Rewrite a stored USER row in place with the marker (same-id upsert — steer-preserving-turn
 * precedent, R2). `sessionLike` is the SteerableSession subset this module needs; tests inject a
 * fake, TN cert runs it against real Mastra storage.
 */
export interface MarkerWritableRow {
  id: string;
  role?: unknown;
  content?: { parts?: unknown; metadata?: unknown };
}
export interface MarkerSessionLike {
  thread: { listMessages(input: { threadId: string; limit?: number }): Promise<MarkerWritableRow[]> };
  sendSignalToThread(
    signal: {
      id: string;
      type: 'user' | 'notification';
      tagName: string;
      contents: unknown;
      attributes?: Record<string, unknown>;
    },
    target: { resourceId: string; threadId: string },
  ): { accepted: Promise<unknown> };
}

/** Find the stored user row for a key (marker first, then text match, oldest-first order). */
export async function findUserRowForKey(
  session: MarkerSessionLike,
  threadId: string,
  clientMessageId: string,
  text: string,
): Promise<MarkerWritableRow | null> {
  const rows = await session.thread.listMessages({ threadId, limit: 50 });
  let textMatch: MarkerWritableRow | null = null;
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id) continue;
    const meta = row.content?.metadata as { tb364Key?: unknown; signal?: { attributes?: unknown } } | undefined;
    const keyOnRow = meta?.tb364Key ?? readTb364Attrs(meta?.signal?.attributes)?.clientMessageId;
    if (keyOnRow === clientMessageId) return row;
    if (!textMatch) {
      const parts = row.content?.parts;
      const joined = Array.isArray(parts)
        ? parts
            .map((p) => {
              const part = p as { type?: unknown; text?: unknown };
              return (part.type === 'text' || part.type === 'data-user-message') && typeof part.text === 'string' ? part.text : '';
            })
            .join('')
        : '';
      if (joined.trim() === text.trim()) textMatch = row;
    }
  }
  return textMatch;
}

/** Persist a marker onto the stored user row (same id); false when no row was found (caller appends). */
export async function persistMarkerOnUserRow(
  session: MarkerSessionLike,
  opts: { resourceId: string; threadId: string; clientMessageId: string; text: string; fields: Tb364MarkerFields; replaceTextWith?: string },
): Promise<boolean> {
  const row = await findUserRowForKey(session, opts.threadId, opts.clientMessageId, opts.text);
  if (!row) return false;
  const textPart = opts.replaceTextWith ?? opts.text;
  await session
    .sendSignalToThread(
      {
        id: row.id,
        type: 'user',
        tagName: 'user',
        contents: { parts: [{ type: 'text', text: textPart }] },
        attributes: tb364Attrs(opts.fields) as Record<string, unknown>,
      },
      { resourceId: opts.resourceId, threadId: opts.threadId },
    )
    .accepted;
  return true;
}

/** Where a written marker bag is found when read back (both placements are accepted, TN proves the real one). */
function rowBagAttrs(row: MarkerWritableRow): unknown {
  const meta = row.content?.metadata as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  if (typeof meta.tb364Key === 'string') return meta;
  const signal = meta.signal as { attributes?: unknown } | undefined;
  if (signal && typeof signal.attributes === 'object' && signal.attributes !== null) return signal.attributes;
  return meta;
}

/**
 * Persist the outcome of a run for a keyed message: success CLEARS the failure (state 'sent');
 * failure writes state 'failed' with the classified fields and INCREMENTS `attempts` from the
 * stored marker (A23: the cap persists across reload because the truth lives here, not in the
 * client). When no stored user row exists yet (the run died before Mastra wrote it), the marker
 * is APPENDED as its own signal row (tag `tb364-marker`) so nothing is lost (A2, A25b race-free).
 */
export async function persistRunOutcomeMarker(
  session: MarkerSessionLike,
  opts: {
    resourceId: string;
    threadId: string;
    clientMessageId: string;
    text: string;
    ok: boolean;
    failure?: Tb364RunFailure | null;
    /** Id source for the append-only fallback row. */
    newId: () => string;
  },
): Promise<void> {
  const row = await findUserRowForKey(session, opts.threadId, opts.clientMessageId, opts.text);
  const prior = row ? readTb364Attrs(rowBagAttrs(row)) : null;
  if (opts.ok) {
    if (!row || prior?.state !== 'failed') return;
    await persistMarkerOnUserRow(session, {
      resourceId: opts.resourceId,
      threadId: opts.threadId,
      clientMessageId: opts.clientMessageId,
      text: opts.text,
      fields: { clientMessageId: opts.clientMessageId, state: 'sent', attempts: prior?.attempts },
    });
    return;
  }
  const f = opts.failure;
  const fields: Tb364MarkerFields = {
    clientMessageId: opts.clientMessageId,
    state: 'failed',
    attempts: (prior?.attempts ?? 0) + 1,
    ...(f ? { category: f.category, retryable: f.retryable, technical: f.technical } : {}),
    ...(f?.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}),
    ...(f?.partial ? { partial: true } : {}),
    ...(f?.toolRan ? { toolRan: true } : {}),
  };
  if (row) {
    await persistMarkerOnUserRow(session, {
      resourceId: opts.resourceId,
      threadId: opts.threadId,
      clientMessageId: opts.clientMessageId,
      text: opts.text,
      fields,
    });
    return;
  }
  await session
    .sendSignalToThread(
      {
        id: opts.newId(),
        type: 'notification',
        tagName: TB364_MARKER_TAG,
        contents: { parts: [{ type: 'text', text: '' }] },
        attributes: tb364Attrs(fields) as Record<string, unknown>,
      },
      { resourceId: opts.resourceId, threadId: opts.threadId },
    )
    .accepted;
}

/**
 * TB-364 (A14/A35): mark a message discarded. The user row's text is replaced by the placeholder
 * (context exclusion, M50) and the marker carries state 'discarded' + the original text; a keyed
 * marker/queue signal row is rewritten in place instead. 404 when the key is unknown — never
 * re-runnable afterwards (a run POST with the key is refused by the route's discarded check).
 */
export async function persistDiscardMarker(
  session: MarkerSessionLike,
  opts: { resourceId: string; threadId: string; clientMessageId: string; newId: () => string },
): Promise<boolean> {
  const rows = await session.thread.listMessages({ threadId: opts.threadId, limit: 200 });
  const row = rows.find((r) => {
    if (typeof r.id !== 'string' || !r.id) return false;
    return readTb364Attrs(rowBagAttrs(r))?.clientMessageId === opts.clientMessageId;
  });
  if (!row) return false;
  const prior = readTb364Attrs(rowBagAttrs(row));
  // Is this the real user row (has a text part) or an appended marker/queue signal row?
  const parts = row.content?.parts;
  const isUserRow =
    Array.isArray(parts) &&
    parts.some((p) => {
      const part = p as { type?: unknown; text?: unknown };
      return (part.type === 'text' || part.type === 'data-user-message') && typeof part.text === 'string' && part.text !== DISCARDED_PLACEHOLDER_TEXT;
    });
  const originalText = prior?.text ?? (isUserRow ? rowText(row) : '');
  if (isUserRow) {
    await persistMarkerOnUserRow(session, {
      resourceId: opts.resourceId,
      threadId: opts.threadId,
      clientMessageId: opts.clientMessageId,
      text: rowText(row),
      fields: {
        clientMessageId: opts.clientMessageId,
        state: 'discarded',
        ...(prior?.category ? { category: prior.category } : {}),
        ...(typeof prior?.retryable === 'boolean' ? { retryable: prior.retryable } : {}),
        ...(prior?.attempts !== undefined ? { attempts: prior.attempts } : {}),
        text: originalText,
      },
      replaceTextWith: DISCARDED_PLACEHOLDER_TEXT,
    });
    return true;
  }
  await session
    .sendSignalToThread(
      {
        id: row.id,
        type: 'notification',
        tagName: TB364_MARKER_TAG,
        contents: { parts: [{ type: 'text', text: '' }] },
        attributes: tb364Attrs({
          clientMessageId: opts.clientMessageId,
          state: 'discarded',
          ...(prior?.category ? { category: prior.category } : {}),
          ...(typeof prior?.retryable === 'boolean' ? { retryable: prior.retryable } : {}),
          ...(prior?.attempts !== undefined ? { attempts: prior.attempts } : {}),
          ...(originalText ? { text: originalText } : {}),
        }) as Record<string, unknown>,
      },
      { resourceId: opts.resourceId, threadId: opts.threadId },
    )
    .accepted;
  return true;
}

/** Joined text of a stored row's text / data-user-message parts. */
function rowText(row: MarkerWritableRow): string {
  const parts = row.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      const part = p as { type?: unknown; text?: unknown };
      return (part.type === 'text' || part.type === 'data-user-message') && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

/**
 * TB-364 (A28): a follow-up accepted into the queue gets an APPEND-ONLY waiting row so a fresh
 * device/tab shows m2/m3 waiting, in order, with their keys. The text lives ONLY in the marker
 * attributes and the parts text is empty — a signal row must never feed the model the waiting
 * message early (A12b/M16). No row is written when the keyed user row already exists.
 */
export async function persistQueueMarkerRow(
  session: MarkerSessionLike,
  opts: { resourceId: string; threadId: string; clientMessageId: string; text: string; newId: () => string },
): Promise<void> {
  const rows = await session.thread.listMessages({ threadId: opts.threadId, limit: 200 });
  for (const r of rows) {
    if (readTb364Attrs(rowBagAttrs(r))?.clientMessageId === opts.clientMessageId) return; // already stored
  }
  await session
    .sendSignalToThread(
      {
        id: opts.newId(),
        type: 'notification',
        tagName: TB364_QUEUE_TAG,
        contents: { parts: [{ type: 'text', text: '' }] },
        attributes: tb364Attrs({ clientMessageId: opts.clientMessageId, state: 'waiting', text: opts.text }) as Record<string, unknown>,
      },
      { resourceId: opts.resourceId, threadId: opts.threadId },
    )
    .accepted;
}

/** TB-364 (A32e): a discarded key can never be replayed to run the message. */
export async function isKeyDiscarded(session: MarkerSessionLike, threadId: string, clientMessageId: string): Promise<boolean> {
  const rows = await session.thread.listMessages({ threadId, limit: 200 });
  return rows.some((r) => {
    const m = readTb364Attrs(rowBagAttrs(r));
    return m?.clientMessageId === clientMessageId && m.state === 'discarded';
  });
}
