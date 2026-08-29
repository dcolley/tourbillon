import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createFirstFrameCaptureFetch,
  getRecentFirstFrameCapture,
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
  });

  describe('getRecentFirstFrameCapture', () => {
    it('returns undefined when no captures exist', () => {
      const capture = getRecentFirstFrameCapture();
      assert.equal(capture, undefined);
    });

    it('returns the most recent capture', async () => {
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

      const wrappedFetch = createFirstFrameCaptureFetch(mockFetch1 as typeof fetch);
      await wrappedFetch('http://localhost:1234/v1/chat/completions', { method: 'POST' });

      const wrappedFetch2 = createFirstFrameCaptureFetch(mockFetch2 as typeof fetch);
      await wrappedFetch2('http://localhost:1234/v1/chat/completions', { method: 'POST' });

      const capture = getRecentFirstFrameCapture();
      assert.ok(capture);
      assert.equal(capture.kind, 'reasoning_content');
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
