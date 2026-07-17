import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReasoningTextFetch, rewriteReasoningTextSseBody } from './reasoning-text-fetch';

describe('rewriteReasoningTextSseBody', () => {
  it('rewrites reasoning_text.delta to reasoning_summary_text.delta with summary_index 0', () => {
    const input = [
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","output_index":0,"content_index":0,"delta":"Thinking","sequence_number":4}',
    ].join('\n');

    const output = rewriteReasoningTextSseBody(input);
    assert.match(output, /response\.reasoning_summary_text\.delta/);
    assert.doesNotMatch(output, /response\.reasoning_text\.delta/);

    const dataLine = output.split('\n').find((line) => line.startsWith('data:'));
    assert.ok(dataLine);
    const parsed = JSON.parse(dataLine!.slice(5).trim()) as Record<string, unknown>;
    assert.equal(parsed.type, 'response.reasoning_summary_text.delta');
    assert.equal(parsed.summary_index, 0);
    assert.equal(parsed.delta, 'Thinking');
  });

  it('rewrites reasoning_text.done to reasoning_summary_part.done', () => {
    const input =
      'data: {"type":"response.reasoning_text.done","item_id":"rs_1","output_index":0,"content_index":0,"sequence_number":800}';

    const output = rewriteReasoningTextSseBody(input);
    const parsed = JSON.parse(output.slice(5).trim()) as Record<string, unknown>;
    assert.equal(parsed.type, 'response.reasoning_summary_part.done');
    assert.equal(parsed.summary_index, 0);
  });

  it('rewrites content_part.added with reasoning_text part to reasoning_summary_part.added', () => {
    const input =
      'data: {"type":"response.content_part.added","item_id":"rs_1","output_index":0,"content_index":0,"part":{"type":"reasoning_text","text":""},"sequence_number":3}';

    const output = rewriteReasoningTextSseBody(input);
    const parsed = JSON.parse(output.slice(5).trim()) as Record<string, unknown>;
    assert.equal(parsed.type, 'response.reasoning_summary_part.added');
    assert.equal(parsed.summary_index, 0);
  });

  it('leaves unrelated SSE lines unchanged', () => {
    const input = [
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hello"}',
      'data: [DONE]',
      'data: not-json',
    ].join('\n');

    assert.equal(rewriteReasoningTextSseBody(input), input);
  });
});

describe('createReasoningTextFetch', () => {
  it('passes through non-responses requests', async () => {
    let called = false;
    const baseFetch: typeof fetch = async () => {
      called = true;
      return new Response('ok', { status: 200 });
    };

    const wrapped = createReasoningTextFetch(baseFetch);
    const res = await wrapped('http://localhost:1234/v1/chat/completions', { method: 'POST' });
    assert.equal(called, true);
    assert.equal(await res.text(), 'ok');
  });

  it('rewrites responses SSE streams', async () => {
    const sse = [
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"Hi","sequence_number":1}',
    ].join('\n');

    const baseFetch: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    const wrapped = createReasoningTextFetch(baseFetch);
    const res = await wrapped('http://localhost:1234/v1/responses', { method: 'POST' });
    const text = await res.text();
    assert.match(text, /reasoning_summary_text\.delta/);
    assert.doesNotMatch(text, /reasoning_text\.delta/);
  });

  it('passes through non-SSE responses responses', async () => {
    const baseFetch: typeof fetch = async () =>
      new Response('{"id":"resp_1"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const wrapped = createReasoningTextFetch(baseFetch);
    const res = await wrapped('http://localhost:1234/v1/responses', { method: 'POST' });
    assert.equal(await res.text(), '{"id":"resp_1"}');
  });
});
