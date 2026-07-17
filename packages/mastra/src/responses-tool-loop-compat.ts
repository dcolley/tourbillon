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
