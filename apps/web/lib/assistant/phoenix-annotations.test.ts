/** OBS-2: Phoenix annotation client (fetch mocked; no network). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postTraceAnnotation } from './phoenix-annotations';
import type { TraceAnnotation } from './feedback';

const annotation: TraceAnnotation = {
  trace_id: 'abc123',
  name: 'user_feedback',
  annotator_kind: 'HUMAN',
  identifier: 'user:board:message:m1',
  result: { label: 'thumbs_down', score: 0, explanation: 'wrong' },
  metadata: { userId: 'board' },
};

function recorder(response: () => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('OBS-2 Phoenix annotation client', () => {
  it('skips without calling anything when Phoenix is not configured', async () => {
    const { calls, fetchImpl } = recorder(async () => new Response('{}'));
    assert.equal(await postTraceAnnotation(annotation, { baseUrl: null, fetch: fetchImpl }), 'skipped');
    assert.equal(await postTraceAnnotation(annotation, { baseUrl: undefined, fetch: fetchImpl }), 'skipped');
    assert.equal(calls.length, 0);
  });

  it('posts one trace annotation to /v1/trace_annotations, with the API key when set', async () => {
    const { calls, fetchImpl } = recorder(async () => new Response('{"data":[]}', { status: 200 }));
    assert.equal(await postTraceAnnotation(annotation, { baseUrl: 'http://phoenix.test', apiKey: 'k-1', fetch: fetchImpl }), 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://phoenix.test/v1/trace_annotations');
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer k-1');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { data: [annotation] });
    assert.ok(calls[0].init.signal, 'request has a timeout');

    await postTraceAnnotation(annotation, { baseUrl: 'http://phoenix.test', apiKey: null, fetch: fetchImpl });
    assert.equal((calls[1].init.headers as Record<string, string>).Authorization, undefined);
  });

  it('reports failed (and never throws) on a refusal or a network error', async () => {
    const warn = console.warn;
    const logged: unknown[][] = [];
    console.warn = (...args: unknown[]) => void logged.push(args);
    try {
      const refused = recorder(async () => new Response('no', { status: 404 }));
      assert.equal(await postTraceAnnotation(annotation, { baseUrl: 'http://phoenix.test', fetch: refused.fetchImpl }), 'failed');
      const down = recorder(async () => {
        throw new TypeError('fetch failed: http://phoenix.test');
      });
      assert.equal(await postTraceAnnotation(annotation, { baseUrl: 'http://phoenix.test', fetch: down.fetchImpl }), 'failed');
      assert.equal(logged.length, 2);
      assert.doesNotMatch(JSON.stringify(logged), /phoenix\.test/, 'the Phoenix address is not logged');
    } finally {
      console.warn = warn;
    }
  });
});
