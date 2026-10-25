/**
 * OBS-2: thumbs up / down on assistant messages, used as eval labels. Client-safe (no db, no env).
 *
 * A reaction is stored per user per message in the thread's metadata
 * (`metadata.assistantFeedback[messageId][userKey]`, see feedback-store.ts) and, when the message
 * has a trace and Phoenix is configured, posted to that trace as a HUMAN annotation (see
 * phoenix-annotations.ts). Saving again replaces the user's reaction (idempotent, changeable).
 */
import { z } from 'zod';

export const FEEDBACK_RATINGS = ['up', 'down'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/** Optional preset reasons offered with a thumbs down. */
export const FEEDBACK_TAGS = ['incorrect', 'unhelpful', 'incomplete', 'off_topic', 'unsafe'] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

export const FEEDBACK_TAG_LABEL: Record<FeedbackTag, string> = {
  incorrect: 'Incorrect',
  unhelpful: 'Not helpful',
  incomplete: 'Incomplete',
  off_topic: 'Off topic',
  unsafe: 'Unsafe',
};

export const FEEDBACK_REASON_MAX = 500;
/** Thread metadata key holding reactions: `{ [messageId]: { [userKey]: MessageFeedback } }`. */
export const ASSISTANT_FEEDBACK_METADATA_KEY = 'assistantFeedback';
/** Phoenix annotation name for these reactions. */
export const FEEDBACK_ANNOTATION_NAME = 'user_feedback';

export interface MessageFeedback {
  rating: FeedbackRating;
  /** Free-text reason (thumbs down only). */
  reason: string | null;
  /** Preset reasons (thumbs down only). */
  tags: FeedbackTag[];
  updatedAt: string;
}

/** The viewer's reactions in one thread, by message id. */
export type ThreadFeedback = Record<string, MessageFeedback>;

/** What happened to the Phoenix annotation for a save. */
export type AnnotationOutcome = 'sent' | 'skipped' | 'failed';

/** Mastra message ids (uuid-like); dot-only ids are refused. */
const MESSAGE_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export function isFeedbackMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_RE.test(value) && !/^\.+$/.test(value);
}

export const feedbackInputSchema = z
  .object({
    messageId: z.string().refine(isFeedbackMessageId, { message: 'Invalid message id' }),
    rating: z.enum(FEEDBACK_RATINGS),
    reason: z.string().max(FEEDBACK_REASON_MAX).nullable().optional(),
    tags: z.array(z.enum(FEEDBACK_TAGS)).max(FEEDBACK_TAGS.length).optional(),
  })
  .strict();
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

/** Control, bidi and zero-width characters; newlines and tabs are kept. */
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Trimmed reason without control / bidi / zero-width characters; empty → null. */
export function normaliseFeedbackReason(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_CHARS, '').trim().slice(0, FEEDBACK_REASON_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

/** The stored entry for an input: a thumbs up carries no reason or tags; tags are de-duplicated. */
export function buildMessageFeedback(input: FeedbackInput, now: Date = new Date()): MessageFeedback {
  const down = input.rating === 'down';
  const tags = down ? FEEDBACK_TAGS.filter((t) => input.tags?.includes(t)) : [];
  return {
    rating: input.rating,
    reason: down ? normaliseFeedbackReason(input.reason) : null,
    tags,
    updatedAt: now.toISOString(),
  };
}

/**
 * Mastra message id for a chat item id. The AG-UI bridge uses the Mastra message id for the first
 * text segment of a message and `<id>:text:<n>` / `<id>:reasoning:<n>` for later segments
 * (lib/agui/session-events.ts), so every segment maps back to its stored message.
 */
export function feedbackMessageId(itemId: string): string {
  return itemId.replace(/:(?:text|reasoning):\d+$/, '');
}

function parseEntry(value: unknown): MessageFeedback | null {
  const v = value as Partial<MessageFeedback> | null | undefined;
  if (!v || typeof v !== 'object') return null;
  if (v.rating !== 'up' && v.rating !== 'down') return null;
  const tags = Array.isArray(v.tags) ? FEEDBACK_TAGS.filter((t) => (v.tags as unknown[]).includes(t)) : [];
  return {
    rating: v.rating,
    reason: typeof v.reason === 'string' ? normaliseFeedbackReason(v.reason) : null,
    tags: v.rating === 'down' ? tags : [],
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
  };
}

/** One user's reactions from a thread's metadata; malformed entries are ignored. */
export function readThreadFeedback(metadata: unknown, userKey: string): ThreadFeedback {
  const all = (metadata as Record<string, unknown> | null | undefined)?.[ASSISTANT_FEEDBACK_METADATA_KEY];
  const out: ThreadFeedback = {};
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  for (const [messageId, byUser] of Object.entries(all as Record<string, unknown>)) {
    if (!isFeedbackMessageId(messageId) || !byUser || typeof byUser !== 'object') continue;
    const entry = parseEntry((byUser as Record<string, unknown>)[userKey]);
    if (entry) out[messageId] = entry;
  }
  return out;
}

export interface FeedbackAnnotationContext {
  traceId: string;
  messageId: string;
  threadId: string;
  agentId: string;
  companyId: string;
  userKey: string;
}

/** Phoenix trace annotation (POST /v1/trace_annotations `data[]` item) for a reaction. */
export interface TraceAnnotation {
  trace_id: string;
  name: string;
  annotator_kind: 'HUMAN';
  /** Same user + message → same identifier, so Phoenix updates the annotation instead of adding one. */
  identifier: string;
  result: { label: string; score: number; explanation: string | null };
  metadata: Record<string, unknown>;
}

export function feedbackAnnotation(ctx: FeedbackAnnotationContext, feedback: MessageFeedback): TraceAnnotation {
  return {
    trace_id: ctx.traceId.toLowerCase(),
    name: FEEDBACK_ANNOTATION_NAME,
    annotator_kind: 'HUMAN',
    identifier: `user:${ctx.userKey}:message:${ctx.messageId}`,
    result: {
      label: feedback.rating === 'up' ? 'thumbs_up' : 'thumbs_down',
      score: feedback.rating === 'up' ? 1 : 0,
      explanation: feedback.reason,
    },
    metadata: {
      userId: ctx.userKey,
      messageId: ctx.messageId,
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      companyId: ctx.companyId,
      tags: feedback.tags,
    },
  };
}

/**
 * Where reaction controls go in a chat: after the last text segment of each finished assistant
 * message (item id → Mastra message id). The message still being written in an open run gets none.
 */
export function feedbackTargets(
  items: ReadonlyArray<{ kind: string; id: string; streaming?: boolean }>,
  runOpen: boolean,
): Map<string, string> {
  const lastSegment = new Map<string, { id: string; streaming: boolean }>();
  let latest: string | null = null;
  for (const item of items) {
    if (item.kind !== 'assistant') continue;
    const messageId = feedbackMessageId(item.id);
    lastSegment.set(messageId, { id: item.id, streaming: item.streaming === true });
    latest = messageId;
  }
  const out = new Map<string, string>();
  for (const [messageId, seg] of lastSegment) {
    if (seg.streaming || (runOpen && messageId === latest)) continue;
    if (!isFeedbackMessageId(messageId)) continue;
    out.set(seg.id, messageId);
  }
  return out;
}
