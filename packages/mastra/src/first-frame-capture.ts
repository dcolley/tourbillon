/**
 * Captures first SSE frame kind from streaming LLM responses for diagnostics.
 * When a stream fails before output, the kind helps distinguish SDK validation
 * issues from provider rejections.
 */

const MAX_FRAME_EXCERPT_CHARS = 500;

export type FirstFrameKind = 'error' | 'content' | 'reasoning_content' | 'other';

export interface FirstFrameCapture {
  kind: FirstFrameKind;
  /** Capped excerpt of the first data frame for diagnostics. */
  excerpt?: string;
}

interface FirstFrameCaptureEntry {
  capture: FirstFrameCapture;
  timestamp: number;
  url: string;
}

/**
 * Thread-local storage for first frame captures.
 * Time-based cleanup allows error handlers to retrieve recent captures.
 */
const firstFrameStore: FirstFrameCaptureEntry[] = [];
const MAX_CAPTURE_AGE_MS = 10_000; // 10 seconds

/**
 * Get the most recent first frame capture, if any exists within the time window.
 * Used by error handlers to include frame diagnostics.
 */
export function getRecentFirstFrameCapture(): FirstFrameCapture | undefined {
  const now = Date.now();
  
  // Clean up old captures
  while (firstFrameStore.length > 0 && now - firstFrameStore[0].timestamp > MAX_CAPTURE_AGE_MS) {
    firstFrameStore.shift();
  }
  
  // Return the most recent capture
  if (firstFrameStore.length > 0) {
    const entry = firstFrameStore[firstFrameStore.length - 1];
    return entry.capture;
  }
  
  return undefined;
}

/**
 * Clear all stored captures. Used in tests.
 */
export function clearAllFirstFrameCaptures(): void {
  firstFrameStore.length = 0;
}

function storeFirstFrameCapture(url: string, capture: FirstFrameCapture): void {
  firstFrameStore.push({
    capture,
    timestamp: Date.now(),
    url,
  });
  
  // Keep only the most recent 10 captures to prevent unbounded growth
  if (firstFrameStore.length > 10) {
    firstFrameStore.shift();
  }
}

function isChatCompletionsPost(url: string | URL, init?: RequestInit): boolean {
  const urlText = typeof url === 'string' ? url : url.toString();
  if (!urlText.includes('/chat/completions')) return false;
  const method = init?.method?.toUpperCase() ?? 'GET';
  return method === 'POST';
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/event-stream');
}

/**
 * Extract first frame kind from the first SSE data event.
 * Chat completions format: `data: {"choices":[{"delta":{"content":"...","reasoning_content":"..."},...}],...}`
 */
function detectFirstFrameKind(sseBody: string): FirstFrameCapture {
  const lines = sseBody.split('\n');
  
  for (const line of lines) {
    // Check for error events first
    if (line.startsWith('event:') && line.includes('error')) {
      return { kind: 'error' };
    }
    
    if (!line.startsWith('data:')) continue;
    
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      
      // OpenAI chat completions format
      const choices = parsed.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const firstChoice = choices[0] as Record<string, unknown>;
        const delta = firstChoice.delta;
        
        if (delta && typeof delta === 'object') {
          const deltaObj = delta as Record<string, unknown>;
          
          // Check reasoning_content first (Nemotron-omni sends this before content)
          if ('reasoning_content' in deltaObj) {
            return {
              kind: 'reasoning_content',
              excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
            };
          }
          
          if ('content' in deltaObj) {
            return {
              kind: 'content',
              excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
            };
          }
        }
      }
      
      // Responses API format (response.*)
      const type = parsed.type;
      if (typeof type === 'string') {
        if (type.includes('error')) {
          return { kind: 'error' };
        }
        if (type.includes('reasoning')) {
          return {
            kind: 'reasoning_content',
            excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
          };
        }
        if (type.includes('content')) {
          return {
            kind: 'content',
            excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
          };
        }
      }
      
      // Found a data frame but couldn't classify it
      return {
        kind: 'other',
        excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
      };
    } catch {
      // Malformed JSON in data line
      continue;
    }
  }
  
  // No data frames found
  return { kind: 'other' };
}

/**
 * Wraps fetch to capture the first SSE frame kind from chat/completions streams.
 * Stores the capture in a time-based registry that error handlers can query.
 */
export function createFirstFrameCaptureFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const requestInit = input instanceof Request ? undefined : init;

    if (!isChatCompletionsPost(url, requestInit)) {
      return baseFetch(input, init);
    }

    const urlString = typeof url === 'string' ? url : url.toString();
    
    try {
      const response = await baseFetch(input, init);
      
      if (!response.ok) {
        // Non-200 response — no SSE stream to inspect
        return response;
      }
      
      if (!isEventStreamResponse(response)) {
        // Not a stream (probably JSON error response)
        return response;
      }

      // Read the stream body to detect first frame
      const body = await response.text();
      const capture = detectFirstFrameKind(body);
      storeFirstFrameCapture(urlString, capture);

      // Create a new Response with the same body so the SDK can still consume it
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      throw err;
    }
  };
}

/**
 * Extract request key from a Response object that was created by createFirstFrameCaptureFetch.
 * @deprecated Use getRecentFirstFrameCapture() instead.
 */
export function extractFirstFrameRequestKey(response: unknown): string | undefined {
  return undefined;
}

/**
 * Format first frame capture for inclusion in error messages.
 */
export function formatFirstFrameCapture(capture: FirstFrameCapture): string {
  const parts: string[] = [`first_frame: ${capture.kind}`];
  if (capture.excerpt) {
    parts.push(`excerpt: ${capture.excerpt}`);
  }
  return parts.join(' | ');
}
