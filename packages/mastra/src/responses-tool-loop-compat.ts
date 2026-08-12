import type { CompatRule } from '@mastra/core/processors';

/**
 * Language-model prompt messages as seen by CompatRule.applyToPrompt.
 * Kept structural so we do not depend on private @ai-sdk/provider path aliases.
 */
type PromptPart = { type: string; [key: string]: unknown };
type PromptMessage = {
  role: string;
  content: string | PromptPart[];
  [key: string]: unknown;
};
export type ToolLoopCompatPrompt = PromptMessage[];

function hasToolCall(content: PromptPart[]): boolean {
  return content.some((part) => part.type === 'tool-call');
}

function isMonologuePart(part: PromptPart): boolean {
  return part.type === 'reasoning' || part.type === 'text';
}

/**
 * Merge consecutive user text turns into one message.
 * Failed agent turns leave orphan user signals; some providers reject that shape.
 */
export function coalesceConsecutiveUserMessages(
  prompt: ToolLoopCompatPrompt,
): ToolLoopCompatPrompt | undefined {
  let mutated = false;
  const next: ToolLoopCompatPrompt = [];

  for (const message of prompt) {
    const prev = next[next.length - 1];
    if (
      message.role === 'user' &&
      prev?.role === 'user' &&
      Array.isArray(prev.content) &&
      Array.isArray(message.content)
    ) {
      mutated = true;
      next[next.length - 1] = {
        ...prev,
        content: [...prev.content, ...message.content],
      };
      continue;
    }
    next.push(message);
  }

  return mutated ? next : undefined;
}

/**
 * Strip assistant `reasoning` parts from outbound prompts.
 *
 * vLLM (and some LM Studio) Responses servers crash with `KeyError: 'role'` when
 * prior-turn reasoning items are replayed. UI/memory keep the parts; only the
 * provider prompt is sanitized.
 *
 * Returns a new prompt only when something changed; otherwise `undefined`.
 */
export function stripAssistantReasoningFromPrompt(
  prompt: ToolLoopCompatPrompt,
): ToolLoopCompatPrompt | undefined {
  let mutated = false;
  const next: ToolLoopCompatPrompt = [];

  for (const message of prompt) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      next.push(message);
      continue;
    }

    const filtered = message.content.filter((part) => part.type !== 'reasoning');
    if (filtered.length === message.content.length) {
      next.push(message);
      continue;
    }

    mutated = true;
    // Drop assistant shells that were reasoning-only (empty content breaks some servers).
    if (filtered.length === 0) continue;
    next.push({ ...message, content: filtered });
  }

  return mutated ? next : undefined;
}

/**
 * Strip assistant `text` / `reasoning` parts when the same message also has a
 * `tool-call`. Those monologue parts are re-serialized by @ai-sdk/openai as
 * invalid Responses `output_text` items on the next multi-step request.
 *
 * Returns a new prompt only when something changed; otherwise `undefined`.
 */
export function stripToolLoopMonologueFromPrompt(
  prompt: ToolLoopCompatPrompt,
): ToolLoopCompatPrompt | undefined {
  let mutated = false;
  const next = prompt.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!Array.isArray(message.content)) return message;
    if (!hasToolCall(message.content)) return message;

    const filtered = message.content.filter((part) => !isMonologuePart(part));
    if (filtered.length === message.content.length) return message;

    mutated = true;
    return { ...message, content: filtered };
  });

  return mutated ? next : undefined;
}

/**
 * ProviderHistoryCompat rule: merge consecutive user messages outbound-only.
 */
export const coalesceConsecutiveUserMessagesRule: CompatRule = {
  name: 'coalesce-consecutive-user-messages',
  applyToPrompt({ prompt }) {
    const next = coalesceConsecutiveUserMessages(
      prompt as unknown as ToolLoopCompatPrompt,
    );
    if (!next) return undefined;
    return next as typeof prompt;
  },
};

/**
 * ProviderHistoryCompat rule: outbound-only strip of assistant reasoning.
 * Persisted message lists (memory, UI, observability) are unchanged.
 */
export const stripAssistantReasoning: CompatRule = {
  name: 'strip-assistant-reasoning',
  applyToPrompt({ prompt }) {
    const stripped = stripAssistantReasoningFromPrompt(
      prompt as unknown as ToolLoopCompatPrompt,
    );
    if (!stripped) return undefined;
    return stripped as typeof prompt;
  },
};

/**
 * ProviderHistoryCompat rule: outbound-only strip for tool-loop monologue.
 * Persisted message lists (memory, UI, observability) are unchanged.
 */
export const stripToolLoopAssistantMonologue: CompatRule = {
  name: 'strip-tool-loop-assistant-monologue',
  applyToPrompt({ prompt }) {
    const stripped = stripToolLoopMonologueFromPrompt(
      prompt as unknown as ToolLoopCompatPrompt,
    );
    if (!stripped) return undefined;
    return stripped as typeof prompt;
  },
};
