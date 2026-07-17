/**
 * Rewrites LM Studio / vLLM Responses SSE events into the shape @ai-sdk/openai expects.
 *
 * Local stacks emit `response.reasoning_text.*`; the AI SDK only maps
 * `response.reasoning_summary_*`, which leaves Mastra MODEL_CHUNK spans empty.
 */

const REASONING_TEXT_DELTA = 'response.reasoning_text.delta';
const REASONING_TEXT_DONE = 'response.reasoning_text.done';
const REASONING_SUMMARY_TEXT_DELTA = 'response.reasoning_summary_text.delta';
const REASONING_SUMMARY_PART_DONE = 'response.reasoning_summary_part.done';
const REASONING_SUMMARY_PART_ADDED = 'response.reasoning_summary_part.added';
const CONTENT_PART_ADDED = 'response.content_part.added';

function isResponsesPost(url: string | URL, init?: RequestInit): boolean {
  const urlText = typeof url === 'string' ? url : url.toString();
  if (!urlText.includes('/responses')) return false;
  const method = init?.method?.toUpperCase() ?? 'GET';
  return method === 'POST';
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/event-stream');
}

function rewriteReasoningTextEventLine(line: string): string {
  if (!line.includes('reasoning_text')) return line;
  return line
    .replaceAll(REASONING_TEXT_DELTA, REASONING_SUMMARY_TEXT_DELTA)
    .replaceAll(REASONING_TEXT_DONE, REASONING_SUMMARY_PART_DONE);
}

function rewriteReasoningTextPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const type = obj.type;
  if (typeof type !== 'string') return obj;

  if (type === REASONING_TEXT_DELTA) {
    return {
      ...obj,
      type: REASONING_SUMMARY_TEXT_DELTA,
      summary_index: typeof obj.summary_index === 'number' ? obj.summary_index : 0,
    };
  }

  if (type === REASONING_TEXT_DONE) {
    return {
      ...obj,
      type: REASONING_SUMMARY_PART_DONE,
      summary_index: typeof obj.summary_index === 'number' ? obj.summary_index : 0,
    };
  }

  if (type === CONTENT_PART_ADDED) {
    const part = obj.part;
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type?: string }).type === 'reasoning_text'
    ) {
      return {
        ...obj,
        type: REASONING_SUMMARY_PART_ADDED,
        summary_index: typeof obj.summary_index === 'number' ? obj.summary_index : 0,
      };
    }
  }

  return obj;
}

/** Rewrite SSE body lines for reasoning_text compatibility. Exported for tests. */
export function rewriteReasoningTextSseBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      if (line.startsWith('event:')) {
        return rewriteReasoningTextEventLine(line);
      }

      if (!line.startsWith('data:')) return line;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return line;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const rewritten = rewriteReasoningTextPayload(parsed);
        if (rewritten === parsed) return line;
        return `data: ${JSON.stringify(rewritten)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

/** Patch Responses API SSE streams so reasoning_text deltas reach @ai-sdk/openai. */
export function createReasoningTextFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const requestInit = input instanceof Request ? undefined : init;

    if (!isResponsesPost(url, requestInit)) {
      return baseFetch(input, init);
    }

    const response = await baseFetch(input, init);
    if (!isEventStreamResponse(response)) {
      return response;
    }

    const body = await response.text();
    const rewritten = rewriteReasoningTextSseBody(body);

    return new Response(rewritten, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
