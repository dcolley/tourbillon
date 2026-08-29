import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createFirstFrameCaptureFetch,
  getRecentFirstFrameCapture,
  getFirstFrameCapture,
  extractFirstFrameRequestKey,
  clearAllFirstFrameCaptures,
  formatFirstFrameCapture,
  type FirstFrameCapture,
} from './first-frame-capture';

describe('first-frame-capture', () => {
  beforeEach(() => {
    clearAllFirstFrameCaptures();
  });

  describe('detectFirstFrameKind', () => {
    it('detects reasoning_content from chat completions delta', async () => {
      const mockFetch = async () => {
        const sseBody = [
          'data: {"choices":[{"delta":{"reasoning_content":"Let me think...","role":"assistant"},"index":0}]}',
          '',
          'data: [DONE]',
        ].join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'reasoning_content');
      assert.ok(capture.excerpt);
      assert.ok(capture.excerpt.includes('reasoning_content'));
    });

    it('detects content from chat completions delta', async () => {
      const mockFetch = async () => {
        const sseBody = [
          'data: {"choices":[{"delta":{"content":"Hello","role":"assistant"},"index":0}]}',
          '',
          'data: [DONE]',
        ].join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'content');
      assert.ok(capture.excerpt);
      assert.ok(capture.excerpt.includes('content'));
    });

    it('detects error events', async () => {
      const mockFetch = async () => {
        const sseBody = ['event: error', 'data: {"error":{"message":"Failed"}}', ''].join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'error');
    });

    it('prioritizes reasoning_content over content when both present', async () => {
      const mockFetch = async () => {
        const sseBody = [
          'data: {"choices":[{"delta":{"reasoning_content":"Thinking...","content":"","role":"assistant"},"index":0}]}',
          '',
          'data: [DONE]',
        ].join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'reasoning_content');
    });

    it('classifies unknown data frames as other', async () => {
      const mockFetch = async () => {
        const sseBody = ['data: {"unknown":"frame"}', '', 'data: [DONE]'].join('\n');

        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'other');
    });

    it('does not capture non-chat-completions requests', async () => {
      const mockFetch = async () => {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/models', {
        method: 'GET',
      });

      const capture = getRecentFirstFrameCapture();
      assert.equal(capture, undefined);
    });

    it('does not capture non-stream responses', async () => {
      const mockFetch = async () => {
        return new Response('{"error":"Bad request"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      const capture = getRecentFirstFrameCapture();
      assert.equal(capture, undefined);
    });

    it('does not consume the rest of the stream after peeking first frame', async () => {
      let chunkCount = 0;
      const mockFetch = async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // First chunk with reasoning_content
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"reasoning_content":"Thinking...","role":"assistant"},"index":0}]}\n\n'
              )
            );
            // Second chunk with content
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"Answer","role":"assistant"},"index":0}]}\n\n'
              )
            );
            // Done
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch as typeof fetch);

      const response = await wrappedFetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });

      // Verify first frame was captured
      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'reasoning_content');

      // Verify the stream is still consumable
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunkCount++;
          fullText += decoder.decode(value, { stream: true });
        }
      }

      // Should have read all chunks
      assert.ok(chunkCount > 0, 'Should have read at least one chunk');
      assert.ok(fullText.includes('reasoning_content'), 'Should contain first frame');
      assert.ok(fullText.includes('content'), 'Should contain second frame');
      assert.ok(fullText.includes('[DONE]'), 'Should contain done marker');
    });
  });

  describe('getFirstFrameCapture', () => {
    it('returns undefined when no captures exist', () => {
      const capture = getFirstFrameCapture('nonexistent-key');
      assert.equal(capture, undefined);
    });

    it('returns capture for specific request key', async () => {
      const mockFetch1 = async () => {
        return new Response('data: {"choices":[{"delta":{"content":"First"}}]}\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      const mockFetch2 = async () => {
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"Second"}}]}\n',
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }
        );
      };

      const wrappedFetch1 = createFirstFrameCaptureFetch(mockFetch1 as typeof fetch);
      const response1 = await wrappedFetch1('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
      });

      const wrappedFetch2 = createFirstFrameCaptureFetch(mockFetch2 as typeof fetch);
      const response2 = await wrappedFetch2('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
      });

      // Extract request keys from responses
      const key1 = extractFirstFrameRequestKey(response1);
      const key2 = extractFirstFrameRequestKey(response2);

      assert.ok(key1);
      assert.ok(key2);
      assert.notEqual(key1, key2, 'Request keys should be unique');

      // Verify each capture is retrievable by its key
      const capture1 = getFirstFrameCapture(key1);
      const capture2 = getFirstFrameCapture(key2);

      assert.ok(capture1);
      assert.equal(capture1.kind, 'content');

      assert.ok(capture2);
      assert.equal(capture2.kind, 'reasoning_content');
    });
  });

  describe('formatFirstFrameCapture', () => {
    it('formats capture with excerpt', () => {
      const capture: FirstFrameCapture = {
        kind: 'reasoning_content',
        excerpt: '{"choices":[{"delta":{"reasoning_content":"..."}}]}',
      };

      const formatted = formatFirstFrameCapture(capture);
      assert.ok(formatted.includes('first_frame: reasoning_content'));
      assert.ok(formatted.includes('excerpt:'));
    });

    it('formats capture without excerpt', () => {
      const capture: FirstFrameCapture = {
        kind: 'error',
      };

      const formatted = formatFirstFrameCapture(capture);
      assert.equal(formatted, 'first_frame: error');
    });
  });
});
