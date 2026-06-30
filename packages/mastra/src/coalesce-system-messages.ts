export type OpenAICompatibleMessage = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

function isSystemRole(role: string): boolean {
  const normalized = role.toLowerCase();
  return normalized === 'system' || normalized === 'developer';
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function needsSystemCoalescing(messages: OpenAICompatibleMessage[]): boolean {
  let leadingSystemCount = 0;
  let sawNonSystem = false;

  for (const message of messages) {
    if (isSystemRole(message.role)) {
      if (!sawNonSystem) leadingSystemCount++;
      else return true;
    } else {
      sawNonSystem = true;
    }
  }

  return leadingSystemCount > 1;
}

/**
 * Merge scattered or multiple system messages into a single leading system block.
 * Required for Qwen-family chat templates served via vLLM, which reject mid-conversation
 * system roles and multiple leading system messages.
 */
export function coalesceSystemMessages<T extends OpenAICompatibleMessage>(messages: T[]): T[] {
  if (messages.length === 0 || !needsSystemCoalescing(messages)) {
    return messages;
  }

  const systemTexts: string[] = [];
  const rest: T[] = [];
  let template: T | undefined;

  for (const message of messages) {
    if (isSystemRole(message.role)) {
      template ??= message;
      const text = extractTextContent(message.content);
      if (text) systemTexts.push(text);
    } else {
      rest.push(message);
    }
  }

  if (systemTexts.length === 0) return rest;

  const merged = {
    ...(template ?? { role: 'system' }),
    role: 'system',
    content: systemTexts.join('\n\n'),
  } as T;

  return [merged, ...rest];
}

function isChatCompletionsRequest(url: string | URL, init?: RequestInit): boolean {
  const urlText = typeof url === 'string' ? url : url.toString();
  if (!urlText.includes('/chat/completions')) return false;
  const method = init?.method?.toUpperCase() ?? 'GET';
  return method === 'POST';
}

export function createCoalescingFetch(
  baseFetch: typeof fetch,
  enabled: boolean,
): typeof fetch {
  if (!enabled) return baseFetch;

  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const requestInit = input instanceof Request ? undefined : init;

    if (!isChatCompletionsRequest(url, requestInit)) {
      return baseFetch(input, init);
    }

    const body =
      requestInit?.body ??
      (input instanceof Request && input.method === 'POST' ? await input.clone().text() : undefined);

    if (typeof body !== 'string') {
      return baseFetch(input, init);
    }

    try {
      const parsed = JSON.parse(body) as { messages?: OpenAICompatibleMessage[] };
      if (!Array.isArray(parsed.messages)) {
        return baseFetch(input, init);
      }

      const normalized = coalesceSystemMessages(parsed.messages);
      if (normalized === parsed.messages) {
        return baseFetch(input, init);
      }

      const nextBody = JSON.stringify({ ...parsed, messages: normalized });

      if (input instanceof Request) {
        return baseFetch(
          new Request(input, { body: nextBody }),
          undefined,
        );
      }

      return baseFetch(input, { ...requestInit, body: nextBody });
    } catch {
      return baseFetch(input, init);
    }
  };
}
