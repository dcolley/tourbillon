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
  requestKey: string;
}

/**
 * Per-request storage for first frame captures.
 * Each request gets a unique key to avoid collisions in concurrent heartbeats.
 */
const firstFrameStore: FirstFrameCaptureEntry[] = [];
const MAX_CAPTURE_AGE_MS = 10_000; // 10 seconds

/**
 * Generate a unique key for this request based on URL and timestamp.
 */
function makeRequestKey(url: string): string {
  return `${url}:${Date.now()}:${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Get the first frame capture for a specific request key.
 */
export function getFirstFrameCapture(requestKey: string): FirstFrameCapture | undefined {
  const now = Date.now();
  
  // Clean up old captures
  while (firstFrameStore.length > 0 && now - firstFrameStore[0].timestamp > MAX_CAPTURE_AGE_MS) {
    firstFrameStore.shift();
  }
  
  // Find the capture for this specific request
  const entry = firstFrameStore.find(e => e.requestKey === requestKey);
  return entry?.capture;
}

/**
 * Get the most recent first frame capture (for backward compatibility).
 * Prefer getFirstFrameCapture(requestKey) when available.
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

function storeFirstFrameCapture(requestKey: string, capture: FirstFrameCapture): void {
  firstFrameStore.push({
    capture,
    timestamp: Date.now(),
    requestKey,
  });
  
  // Keep only the most recent 20 captures to prevent unbounded growth
  if (firstFrameStore.length > 20) {
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
 * Peek at the first SSE data event from a ReadableStream without consuming the rest.
 * Tees the stream and reads only until the first frame is found.
 */
async function peekFirstSseFrame(stream: ReadableStream<Uint8Array>): Promise<{
  capture: FirstFrameCapture;
  stream: ReadableStream<Uint8Array>;
}> {
  // Tee the stream so we can read from one branch and return the other
  const [peekStream, passStream] = stream.tee();
  
  const reader = peekStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let capture: FirstFrameCapture = { kind: 'other' };
  let found = false;

  try {
    // Read chunks until we find the first data frame
    while (!found) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      // Look for first data event in accumulated buffer
      const lines = buffer.split('\n');
      
      for (const line of lines) {
        // Check for error events first
        if (line.startsWith('event:') && line.includes('error')) {
          capture = { kind: 'error' };
          found = true;
          break;
        }
        
        if (line.startsWith('data:')) {
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
                  capture = {
                    kind: 'reasoning_content',
                    excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
                  };
                  found = true;
                  break;
                }
                
                if ('content' in deltaObj) {
                  capture = {
                    kind: 'content',
                    excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
                  };
                  found = true;
                  break;
                }
              }
            }
            
            // Responses API format (response.*)
            const type = parsed.type;
            if (typeof type === 'string') {
              if (type.includes('error')) {
                capture = { kind: 'error' };
                found = true;
                break;
              }
              if (type.includes('reasoning')) {
                capture = {
                  kind: 'reasoning_content',
                  excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
                };
                found = true;
                break;
              }
              if (type.includes('content')) {
                capture = {
                  kind: 'content',
                  excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
                };
                found = true;
                break;
              }
            }
            
            // Found a data frame but couldn't classify it
            capture = {
              kind: 'other',
              excerpt: payload.slice(0, MAX_FRAME_EXCERPT_CHARS),
            };
            found = true;
            break;
          } catch {
            // Malformed JSON in data line
            continue;
          }
        }
      }
    }
  } finally {
    // Cancel the peek reader to avoid holding resources
    reader.cancel().catch(() => undefined);
  }

  // Return the untouched pass-through stream
  return { capture, stream: passStream };
}

/**
 * Wraps fetch to capture the first SSE frame kind from chat/completions streams.
 * Peeks at the first frame without consuming the entire stream, preserving streaming.
 * Returns a Response with an attached request key for error correlation.
 */
export function createFirstFrameCaptureFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const requestInit = input instanceof Request ? undefined : init;

    if (!isChatCompletionsPost(url, requestInit)) {
      return baseFetch(input, init);
    }

    const urlString = typeof url === 'string' ? url : url.toString();
    const requestKey = makeRequestKey(urlString);
    
    try {
      const response = await baseFetch(input, init);
      
      if (!response.ok) {
        // Non-200 response - store error details before returning
        const { storeApiErrorDetailsByRequestKey } = require('./observability/error-details-registry') as typeof import('./observability/error-details-registry');
        
        // Try to read response body for error details
        let responseBody: string | undefined;
        let data: unknown;
        
        try {
          const clonedResponse = response.clone();
          const text = await clonedResponse.text();
          responseBody = text.slice(0, 2000);
          
          // Try to parse as JSON for structured error
          if (text.trim().startsWith('{')) {
            data = JSON.parse(text);
          }
        } catch {
          // Ignore parse errors
        }
        
        storeApiErrorDetailsByRequestKey(requestKey, {
          statusCode: response.status,
          url: urlString,
          responseBody,
          data,
        });
        
        return response;
      }
      
      if (!isEventStreamResponse(response)) {
        // Not a stream (probably JSON error response)
        return response;
      }

      if (!response.body) {
        // No body to peek
        return response;
      }

      // Peek at the first frame without consuming the entire stream
      const { capture, stream: newStream } = await peekFirstSseFrame(response.body);
      storeFirstFrameCapture(requestKey, capture);
      
      // Store error details for ALL peek paths (200 + any first frame kind)
      // This covers: error events, reasoning_content (Nemotron), content, and other
      // Store BEFORE returning so details are available at SPAN_ENDED
      const { storeApiErrorDetailsByRequestKey } = require('./observability/error-details-registry') as typeof import('./observability/error-details-registry');
      
      let responseBody: string | undefined;
      let data: unknown;
      
      // Extract error/response data based on first frame
      if (capture.kind === 'error' && capture.excerpt) {
        responseBody = capture.excerpt;
        try {
          data = JSON.parse(capture.excerpt);
        } catch {
          // Keep excerpt as-is
        }
      } else if (capture.excerpt) {
        // Non-error frames: include excerpt for diagnostics (reasoning_content, content, other)
        responseBody = `First frame: ${capture.kind} | ${capture.excerpt}`;
      }
      
      // Store by requestKey and error pattern for exporter correlation
      // Pattern-based lookup works at SPAN_ENDED without wake-runner catch transfer
      storeApiErrorDetailsByRequestKey(
        requestKey,
        {
          statusCode: response.status,
          url: urlString,
          responseBody: responseBody ? responseBody.slice(0, 2000) : `HTTP ${response.status} stream (${capture.kind} first frame)`,
          data,
        },
        undefined, // companyId not available at fetch level
        undefined  // agentId not available at fetch level
      );

      // Create a new Response with the peeked stream (all content intact)
      const newResponse = new Response(newStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      // Attach request key to response for error handlers to retrieve capture
      Object.defineProperty(newResponse, '__firstFrameRequestKey', {
        value: requestKey,
        enumerable: false,
        writable: false,
      });

      return newResponse;
    } catch (err) {
      // Store AI_APICallError details BEFORE the error bubbles to Mastra (and SPAN_ENDED fires)
      if (err && typeof err === 'object') {
        const apiError = err as Record<string, unknown>;
        
        if (apiError.statusCode !== undefined || apiError.url !== undefined || apiError.responseBody !== undefined) {
          const { storeApiErrorDetailsByRequestKey } = require('./observability/error-details-registry') as typeof import('./observability/error-details-registry');
          
          storeApiErrorDetailsByRequestKey(requestKey, {
            statusCode: typeof apiError.statusCode === 'number' ? apiError.statusCode : undefined,
            url: typeof apiError.url === 'string' ? apiError.url : undefined,
            responseBody: typeof apiError.responseBody === 'string' 
              ? apiError.responseBody.slice(0, 2000) 
              : undefined,
            data: apiError.data,
          });
        }
      }
      
      // Attach request key to error so resolveHeartbeatFailureError can retrieve the first frame capture
      if (err && typeof err === 'object' && !('__firstFrameRequestKey' in err)) {
        Object.defineProperty(err, '__firstFrameRequestKey', {
          value: requestKey,
          enumerable: false,
          writable: false,
        });
      }
      throw err;
    }
  };
}

/**
 * Extract request key from a Response object that was created by createFirstFrameCaptureFetch.
 */
export function extractFirstFrameRequestKey(response: unknown): string | undefined {
  if (response && typeof response === 'object' && '__firstFrameRequestKey' in response) {
    const key = (response as { __firstFrameRequestKey?: unknown }).__firstFrameRequestKey;
    return typeof key === 'string' ? key : undefined;
  }
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
