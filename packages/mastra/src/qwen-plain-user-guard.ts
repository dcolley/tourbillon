import type {
  ProcessInputArgs,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

/**
 * Structural prompt message — avoids depending on private @ai-sdk path aliases.
 * Matches LanguageModelV2Prompt entries used at processLLMRequest.
 */
export type GuardPromptPart = { type: string; text?: string; [key: string]: unknown };
export type GuardPromptMessage = {
  role: string;
  content: string | GuardPromptPart[];
  providerOptions?: unknown;
  [key: string]: unknown;
};
export type GuardPrompt = GuardPromptMessage[];

export const ZERO_PLAIN_USER_TRIPWIRE =
  'No plain role:user remains after token trim (Qwen chat template requires ≥1 plain user)';

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 12_000;

const PIN_STATE_KEY = 'pinnedPlainUser';

/** True when role is user and content has at least one non-empty text part (or string). */
export function isPlainUserMessage(message: GuardPromptMessage): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
  );
}

export function countPlainUserMessages(prompt: GuardPrompt): number {
  return prompt.filter(isPlainUserMessage).length;
}

export function findFirstPlainUserMessage(
  prompt: GuardPrompt,
): GuardPromptMessage | undefined {
  return prompt.find(isPlainUserMessage);
}

/** Insert `pinned` after leading system messages; no-op shape if already has a plain user. */
export function ensurePinnedPlainUser(
  prompt: GuardPrompt,
  pinned: GuardPromptMessage,
): GuardPrompt {
  if (countPlainUserMessages(prompt) > 0) return prompt;
  let insertAt = 0;
  while (insertAt < prompt.length && prompt[insertAt]?.role === 'system') {
    insertAt += 1;
  }
  return [...prompt.slice(0, insertAt), clonePromptMessage(pinned), ...prompt.slice(insertAt)];
}

export function clonePromptMessage(message: GuardPromptMessage): GuardPromptMessage {
  return structuredClone(message);
}

/**
 * Cap oversized tool-result text/json payloads so contiguous trim is less likely
 * to drop the leading user wake. Returns a new prompt only when something changed.
 */
export function capToolResultText(
  prompt: GuardPrompt,
  maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS,
): GuardPrompt | undefined {
  if (maxChars <= 0) return undefined;
  let mutated = false;
  const next = prompt.map((message) => {
    if (message.role !== 'tool' && message.role !== 'assistant') return message;
    if (!Array.isArray(message.content)) return message;

    let partMutated = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const capped = capToolResultOutput(part, maxChars);
      if (capped === part) return part;
      partMutated = true;
      return capped;
    });

    if (!partMutated) return message;
    mutated = true;
    return { ...message, content };
  });

  return mutated ? next : undefined;
}

function capToolResultOutput(
  part: GuardPromptPart,
  maxChars: number,
): GuardPromptPart {
  const output = part.output as { type?: string; value?: unknown } | undefined;
  if (!output || typeof output !== 'object') return part;

  if (output.type === 'text' && typeof output.value === 'string' && output.value.length > maxChars) {
    return {
      ...part,
      output: {
        ...output,
        value: `${output.value.slice(0, maxChars)}\n…[truncated ${output.value.length - maxChars} chars]`,
      },
    };
  }

  if (output.type === 'json') {
    const serialized =
      typeof output.value === 'string' ? output.value : JSON.stringify(output.value);
    if (typeof serialized === 'string' && serialized.length > maxChars) {
      return {
        ...part,
        output: {
          type: 'text',
          value: `${serialized.slice(0, maxChars)}\n…[truncated ${serialized.length - maxChars} chars]`,
        },
      };
    }
  }

  // Some providers nest text directly on the part
  if (typeof part.text === 'string' && part.text.length > maxChars) {
    return {
      ...part,
      text: `${part.text.slice(0, maxChars)}\n…[truncated ${part.text.length - maxChars} chars]`,
    };
  }

  return part;
}

function plainUserFromMessageList(messageList: {
  get?: {
    all?: {
      aiV5?: { model?: () => GuardPromptMessage[] };
      db?: () => Array<{ role: string; content?: unknown }>;
    };
  };
  getLatestUserContent?: () => string | null;
}): GuardPromptMessage | undefined {
  try {
    const modelMsgs = messageList.get?.all?.aiV5?.model?.();
    if (Array.isArray(modelMsgs)) {
      const found = findFirstPlainUserMessage(modelMsgs as GuardPrompt);
      if (found) return clonePromptMessage(found);
    }
  } catch {
    // ignore — fall through
  }

  try {
    const dbMsgs = messageList.get?.all?.db?.();
    if (Array.isArray(dbMsgs)) {
      for (const msg of dbMsgs) {
        if (msg.role !== 'user') continue;
        const text = extractDbUserText(msg.content);
        if (text) {
          return { role: 'user', content: [{ type: 'text', text }] };
        }
      }
    }
  } catch {
    // ignore
  }

  const latest = messageList.getLatestUserContent?.();
  if (typeof latest === 'string' && latest.trim().length > 0) {
    return { role: 'user', content: [{ type: 'text', text: latest }] };
  }
  return undefined;
}

function extractDbUserText(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content;
  if (!content || typeof content !== 'object') return undefined;
  const c = content as { content?: unknown; parts?: unknown };
  // MastraDBMessage contentV2: { format, parts: [...] } or nested
  const parts = Array.isArray((c as any).parts)
    ? (c as any).parts
    : Array.isArray(c.content)
      ? c.content
      : null;
  if (!parts) return undefined;
  const texts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string') {
      texts.push((part as any).text);
    }
  }
  const joined = texts.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

export type PinPlainUserAfterTrimOptions = {
  /** Cap tool-result payloads (0 disables). Default {@link DEFAULT_TOOL_RESULT_MAX_CHARS}. */
  toolResultMaxChars?: number;
};

type ZeroPlainUserMetadata = {
  code: 'ZERO_PLAIN_USER_AFTER_TRIM';
  stepNumber: number;
  promptMessageCount: number;
};

/**
 * Runs after TokenLimiterProcessor. Pins the original plain user wake so
 * contiguous trim cannot leave Qwen with system+assistant+tool only (400
 * "No user query found in messages"). Fail-closed TripWire if restore is
 * impossible.
 */
export class PinPlainUserAfterTrimProcessor
  implements Processor<'pin-plain-user-after-trim', ZeroPlainUserMetadata>
{
  readonly id = 'pin-plain-user-after-trim' as const;
  readonly name = 'Pin Plain User After Trim';
  private readonly toolResultMaxChars: number;

  constructor(options?: PinPlainUserAfterTrimOptions) {
    this.toolResultMaxChars = options?.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  }

  processInput({ messages, state }: ProcessInputArgs): typeof messages {
    if (!state[PIN_STATE_KEY]) {
      for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const text = extractDbUserText((msg as { content?: unknown }).content);
        if (text) {
          state[PIN_STATE_KEY] = {
            role: 'user',
            content: [{ type: 'text', text }],
          } satisfies GuardPromptMessage;
          break;
        }
      }
    }
    return messages;
  }

  processLLMRequest({
    prompt,
    abort,
    state,
    messageList,
    stepNumber,
  }: ProcessLLMRequestArgs<ZeroPlainUserMetadata>): ProcessLLMRequestResult {
    const guardPrompt = prompt as unknown as GuardPrompt;

    // Prefer earliest pin — keep the original wake once captured.
    if (!state[PIN_STATE_KEY]) {
      const fromPrompt = findFirstPlainUserMessage(guardPrompt);
      if (fromPrompt) {
        state[PIN_STATE_KEY] = clonePromptMessage(fromPrompt);
      } else if (messageList) {
        const recovered = plainUserFromMessageList(messageList as any);
        if (recovered) state[PIN_STATE_KEY] = recovered;
      }
    } else if (countPlainUserMessages(guardPrompt) > 0) {
      // Refresh only if we somehow never pinned (already have pin — keep it).
    }

    let next = guardPrompt;
    let mutated = false;

    if (countPlainUserMessages(next) === 0) {
      const pinned = state[PIN_STATE_KEY] as GuardPromptMessage | undefined;
      if (!pinned) {
        // abort() is typed `never` (it throws a TripWire). `return` makes that visible to
        // control-flow narrowing, which ignores never-returning calls through destructured params.
        return abort(ZERO_PLAIN_USER_TRIPWIRE, {
          metadata: {
            code: 'ZERO_PLAIN_USER_AFTER_TRIM',
            stepNumber,
            promptMessageCount: next.length,
          },
        });
      }
      next = ensurePinnedPlainUser(next, pinned);
      mutated = true;
    }

    if (this.toolResultMaxChars > 0) {
      const capped = capToolResultText(next, this.toolResultMaxChars);
      if (capped) {
        next = capped;
        mutated = true;
      }
    }

    if (!mutated) return undefined;
    return { prompt: next as ProcessLLMRequestArgs['prompt'] };
  }
}
