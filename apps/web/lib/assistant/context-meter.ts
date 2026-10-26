/**
 * CTX-1: context meter for one assistant thread (pure helpers, safe in client bundles).
 *
 * Shown beside the composer's model picker as `~used / limit` plus a thin bar.
 *
 * Limit (real, not invented): the chat context budget of the model the thread runs on —
 * `resolveAgentContextBudget(agent, provider, 'chat')`, i.e. provider defaults merged with the
 * agent's `maxContextTokens` (thread model choice applied, CHAT-5). With no configured window the
 * budget falls back to the env history limiter (`HEARTBEAT_CONTEXT_TOKEN_LIMIT`), and the meter says so.
 *
 * Used (an ESTIMATE, documented here and in the tooltip):
 *   - history: the messages Mastra memory recalls into the prompt (the last
 *     `CHAT_MEMORY_LAST_MESSAGES` stored messages), each estimated at chars / 4 plus a small
 *     per-message overhead. Reasoning parts are skipped (chat history sanitisation strips them);
 *     tool calls/results count as their JSON; images/files count a flat amount.
 *   - history is capped at the TokenLimiter limit (older messages are trimmed above it);
 *   - overhead: the budget's system prompt + tool schema reserve for chat
 *     (`toolSchemaReserveForKind('chat')`), not the real prompt size.
 * Observational Memory observations are not counted (follow-up: exact post-run usage).
 */

export const CONTEXT_METER_CHARS_PER_TOKEN = 4;
export const CONTEXT_METER_MESSAGE_OVERHEAD_TOKENS = 4;
export const CONTEXT_METER_ATTACHMENT_TOKENS = 1_000;
/** At this share of the compaction point the meter turns amber ("near"). */
export const CONTEXT_METER_NEAR_RATIO = 0.8;

export type ContextMeterLevel = 'ok' | 'near' | 'over';

/** What GET /api/assistant/agents/[agentId]/threads/[threadId]/context returns as `meter`. */
export interface ThreadContextMeter {
  /** Estimated prompt tokens: recalled history (capped at the trim point) + system/tool overhead. */
  usedTokens: number;
  /** Model context window (`maxContextTokens`), or the env limiter when none is configured. */
  limitTokens: number;
  limitSource: 'model' | 'env';
  /** History tokens kept before older messages are trimmed (TokenLimiter limit). */
  trimAtTokens: number;
  /** Raw estimate of the recalled history (before the trim cap). */
  messageTokens: number;
  /** System prompt + tool schema reserve used as overhead. */
  overheadTokens: number;
  outputReserve: number;
  /** Messages in the recall window / stored on the thread. */
  windowMessages: number;
  totalMessages: number;
  /** Observational Memory starts observing at this many history tokens; null when OM is off. */
  observeAfterTokens: number | null;
  level: ContextMeterLevel;
}

export interface ContextMeterBudgetInput {
  contextTokens: number | null;
  limiterLimit: number;
  outputReserve: number;
}

export interface ContextMeterMessage {
  role?: string;
  content: unknown;
}

const chars = (text: string) => Math.ceil(text.length / CONTEXT_METER_CHARS_PER_TOKEN);

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function partTokens(part: unknown): number {
  if (typeof part === 'string') return chars(part);
  if (!part || typeof part !== 'object') return 0;
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case 'text':
      return typeof p.text === 'string' ? chars(p.text) : 0;
    case 'reasoning':
    case 'step-start':
    case 'redacted-reasoning':
      return 0;
    case 'file':
    case 'image':
      return CONTEXT_METER_ATTACHMENT_TOKENS;
    case 'tool-invocation':
      return chars(safeJson(p.toolInvocation ?? p));
    default:
      return chars(safeJson(p));
  }
}

/** Estimated prompt tokens of one stored message (Mastra v2 `{ format: 2, parts }`, a string, or parts). */
export function estimateMessageTokens(content: unknown): number {
  let body = 0;
  if (typeof content === 'string') body = chars(content);
  else if (Array.isArray(content)) body = content.reduce((n: number, p) => n + partTokens(p), 0);
  else if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (Array.isArray(c.parts)) body = c.parts.reduce((n: number, p) => n + partTokens(p), 0);
    else if (typeof c.content === 'string') body = chars(c.content);
    else body = chars(safeJson(c));
  }
  return body + CONTEXT_METER_MESSAGE_OVERHEAD_TOKENS;
}

export function buildThreadContextMeter(input: {
  budget: ContextMeterBudgetInput;
  /** Thread messages, oldest first. */
  messages: ContextMeterMessage[];
  /** Messages memory recalls into the prompt (Mastra `lastMessages`). */
  lastMessages: number;
  overheadTokens: number;
  observeAfterTokens?: number | null;
}): ThreadContextMeter {
  const { budget } = input;
  const window = input.lastMessages > 0 ? input.messages.slice(-input.lastMessages) : input.messages;
  const messageTokens = window.reduce((n, m) => n + estimateMessageTokens(m.content), 0);
  const trimAtTokens = budget.limiterLimit;
  const overheadTokens = Math.max(0, input.overheadTokens);
  const usedTokens = Math.min(messageTokens, trimAtTokens) + overheadTokens;
  const limitTokens = budget.contextTokens ?? budget.limiterLimit;
  const observeAfterTokens = input.observeAfterTokens ?? null;
  // Compaction point: OM observes first when it is on and sooner than the trim.
  const compactAt = observeAfterTokens ? Math.min(observeAfterTokens, trimAtTokens) : trimAtTokens;
  const level: ContextMeterLevel =
    messageTokens >= trimAtTokens || usedTokens >= limitTokens
      ? 'over'
      : messageTokens >= compactAt * CONTEXT_METER_NEAR_RATIO || usedTokens >= limitTokens * CONTEXT_METER_NEAR_RATIO
        ? 'near'
        : 'ok';
  return {
    usedTokens,
    limitTokens,
    limitSource: budget.contextTokens ? 'model' : 'env',
    trimAtTokens,
    messageTokens,
    overheadTokens,
    outputReserve: budget.outputReserve,
    windowMessages: window.length,
    totalMessages: input.messages.length,
    observeAfterTokens,
    level,
  };
}

/** Compact token count: 980, 1.2k, 12.4k, 128k, 1.2M. */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1_000) return String(v);
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (v < 100_000) return `${one(v / 1_000)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  return `${one(v / 1_000_000)}M`;
}

/** Share of the limit used, 0..1. */
export function contextMeterRatio(meter: Pick<ThreadContextMeter, 'usedTokens' | 'limitTokens'>): number {
  if (!meter.limitTokens || meter.limitTokens <= 0) return 0;
  return Math.min(1, Math.max(0, meter.usedTokens / meter.limitTokens));
}

/** `~12.4k / 128k` */
export function contextMeterLabel(meter: Pick<ThreadContextMeter, 'usedTokens' | 'limitTokens'>): string {
  return `~${formatTokenCount(meter.usedTokens)} / ${formatTokenCount(meter.limitTokens)}`;
}

/** Tooltip text: what is counted, where trimming / OM kick in. */
export function contextMeterTitle(meter: ThreadContextMeter): string {
  const lines = [
    `Context: ~${formatTokenCount(meter.usedTokens)} of ${formatTokenCount(meter.limitTokens)} tokens (estimate)`,
    meter.limitSource === 'model'
      ? `Limit: the model's context window (${formatTokenCount(meter.limitTokens)})`
      : `Limit: no context window configured; using the history limit (${formatTokenCount(meter.limitTokens)})`,
    `History: ~${formatTokenCount(meter.messageTokens)} in the last ${meter.windowMessages} of ${meter.totalMessages} messages; + ~${formatTokenCount(meter.overheadTokens)} system/tools reserve`,
    `Older messages are trimmed above ~${formatTokenCount(meter.trimAtTokens)} history tokens`,
  ];
  if (meter.observeAfterTokens) {
    lines.push(`Observational Memory compacts history after ~${formatTokenCount(meter.observeAfterTokens)} tokens`);
  }
  if (meter.level === 'over') lines.push('At the limit: older messages are being trimmed or compacted');
  else if (meter.level === 'near') lines.push('Near the limit: trimming / compaction kicks in soon');
  lines.push('Estimated at ~4 characters per token; exact usage may differ.');
  return lines.join('\n');
}
