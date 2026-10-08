/**
 * #121 Test softs S1–S4: unit tests for the provider-safety helpers (no network, no DB).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_MAX_REDIRECTS,
  ProviderConfigError,
  ProviderRedirectError,
  ResponseTooLargeError,
  assertNoBaseURLCredentials,
  baseURLHasCredentials,
  fetchWithoutCrossHostRedirects,
  providerEndpoint,
  providerSecretValues,
  readBodyCapped,
  readJsonCapped,
  redactBaseURL,
  redactUrlsInText,
  sameCredentialBoundary,
  scrubProviderSecrets,
} from './provider-safety';

/** A body stream of `chunks` chunks of `size` bytes ('a'), counting how many were pulled. */
function countingStream(size: number, chunks = Infinity) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(size).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe('S1 scrubProviderSecrets', () => {
  const key = 'sk-live-0123456789abcdef';
  const hdr = 'team-secret-value/with"quote';

  it('replaces the API key and header values (raw, JSON-escaped, URL-encoded)', () => {
    const text = [
      `raw ${key}`,
      `json ${JSON.stringify({ 'x-team': hdr })}`,
      `url ?k=${encodeURIComponent(hdr)}`,
      `plain ${hdr}`,
    ].join(' | ');
    const out = scrubProviderSecrets(text, [key, hdr]);
    assert.ok(!out.includes(key), out);
    assert.ok(!out.includes(hdr), out);
    assert.ok(!out.includes(JSON.stringify(hdr).slice(1, -1)), out);
    assert.ok(!out.includes(encodeURIComponent(hdr)), out);
    assert.equal(out.match(/\[redacted\]/g)?.length, 4);
  });

  it('replaces any Bearer/Basic credential even when it is not a known secret', () => {
    const out = scrubProviderSecrets('Authorization: Bearer abc.def-ghi and basic dXNlcjpwYXNz end', []);
    assert.equal(out, 'Authorization: Bearer [redacted] and basic [redacted] end');
  });

  it('a known key inside "Bearer <key>" ends as a single [redacted]', () => {
    assert.equal(scrubProviderSecrets(`Bearer ${key}`, [key]), 'Bearer [redacted]');
  });

  it('strips userinfo and query strings of URLs in the text', () => {
    const out = scrubProviderSecrets('GET http://u:p@h.test/v1/models?api_key=zzz failed', []);
    assert.equal(out, 'GET http://h.test/v1/models failed');
  });

  it('longest secret first; secrets shorter than 3 chars are left alone', () => {
    assert.equal(scrubProviderSecrets('abcdef abc', ['abc', 'abcdef']), '[redacted] [redacted]');
    assert.equal(scrubProviderSecrets('status 1 ok', ['1', '', null, undefined]), 'status 1 ok');
  });

  it('providerSecretValues: key, stored + sent header values, URL password/user/query values', () => {
    const vals = providerSecretValues(
      { apiKey: 'k1', headers: { 'X-A': 'v1' }, baseURL: 'http://user:p%40ss@h/v1?api_key=q1' },
      { Authorization: 'Bearer k1' },
    );
    for (const v of ['k1', 'v1', 'Bearer k1', 'p@ss', 'p%40ss', 'user', 'q1']) assert.ok(vals.includes(v), v);
  });
});

describe('S2 base URL credentials and redaction', () => {
  it('baseURLHasCredentials', () => {
    assert.equal(baseURLHasCredentials('http://user:pass@h.test/v1'), true);
    assert.equal(baseURLHasCredentials('http://user@h.test/v1'), true);
    assert.equal(baseURLHasCredentials('http://h.test/v1?u=a@b'), false);
    assert.equal(baseURLHasCredentials('http://h.test/v1'), false);
    assert.equal(baseURLHasCredentials('not a url'), false);
  });

  it('assertNoBaseURLCredentials throws a 409 ProviderConfigError with a clear code', () => {
    assert.throws(
      () => assertNoBaseURLCredentials('https://a:b@h.test'),
      (err: unknown) =>
        err instanceof ProviderConfigError &&
        err.status === 409 &&
        err.code === 'llm_provider_base_url_credentials' &&
        !err.message.includes('a:b'),
    );
    assertNoBaseURLCredentials('https://h.test/v1');
  });

  it('redactBaseURL strips userinfo, query and fragment; plain URLs round-trip unchanged', () => {
    assert.equal(redactBaseURL('http://h.test:8000/v1'), 'http://h.test:8000/v1');
    assert.equal(redactBaseURL('http://h.test'), 'http://h.test');
    assert.equal(redactBaseURL('http://user:pass@h.test:8000/v1'), 'http://h.test:8000/v1');
    assert.equal(redactBaseURL('http://h.test/v1?api_key=abc'), 'http://h.test/v1');
    assert.equal(redactBaseURL('http://h.test?api_key=abc'), 'http://h.test');
    assert.equal(redactBaseURL('http://h.test/?k=v'), 'http://h.test/');
    assert.equal(redactBaseURL('http://h.test/v1#frag'), 'http://h.test/v1');
    assert.equal(redactBaseURL('weird://u:p@x y?z'), 'weird://x y');
    assert.equal(redactBaseURL(''), '');
  });

  it('redactUrlsInText redacts every URL in a message', () => {
    assert.equal(
      redactUrlsInText('Request cannot be constructed from a URL that includes credentials: http://user:pass@h.test/v1/models'),
      'Request cannot be constructed from a URL that includes credentials: http://h.test/v1/models',
    );
  });

  it('providerEndpoint puts the path before the query string', () => {
    assert.equal(providerEndpoint('http://h.test/v1', 'models'), 'http://h.test/v1/models');
    assert.equal(providerEndpoint('http://h.test/v1/', 'models'), 'http://h.test/v1/models');
    assert.equal(providerEndpoint('http://h.test/v1?api-version=2', 'models'), 'http://h.test/v1/models?api-version=2');
    assert.equal(providerEndpoint('http://h.test', 'api/v1/models'), 'http://h.test/api/v1/models');
  });
});

describe('S3 redirects', () => {
  it('sameCredentialBoundary: same host+port; http→https upgrade ok; downgrade, port or host change not', () => {
    assert.equal(sameCredentialBoundary('http://h.test/v1', 'http://h.test/other'), true);
    assert.equal(sameCredentialBoundary('http://h.test/v1', 'https://h.test/v1'), true);
    assert.equal(sameCredentialBoundary('https://h.test/v1', 'http://h.test/v1'), false);
    assert.equal(sameCredentialBoundary('http://h.test:8000/v1', 'http://h.test:8001/v1'), false);
    assert.equal(sameCredentialBoundary('http://h.test:8000/v1', 'https://h.test:8000/v1'), false);
    assert.equal(sameCredentialBoundary('http://h.test/v1', 'http://evil.test/v1'), false);
    assert.equal(sameCredentialBoundary('http://H.TEST/v1', 'http://h.test/v1'), true);
    assert.equal(sameCredentialBoundary('nope', 'http://h.test'), false);
  });

  type Call = { url: string; init: RequestInit };
  const fakeFetch = (routes: Record<string, () => Response>, calls: Call[]) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const r = routes[url];
      if (!r) throw new TypeError(`unexpected fetch ${url}`);
      return r();
    }) as typeof fetch;
  const redirect = (status: number, location?: string) =>
    new Response(null, { status, headers: location ? { location } : {} });

  it('always asks fetch for redirect: "manual"', async () => {
    const calls: Call[] = [];
    const res = await fetchWithoutCrossHostRedirects('http://h.test/v1/models', { headers: { 'X-K': 's' } },
      fakeFetch({ 'http://h.test/v1/models': () => Response.json({ data: [] }) }, calls));
    assert.equal(res.status, 200);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.method, 'GET');
  });

  it('follows a same-host redirect by hand (relative Location), with the same headers', async () => {
    const calls: Call[] = [];
    const res = await fetchWithoutCrossHostRedirects('http://h.test/v1/models', { headers: { 'X-K': 's' } },
      fakeFetch({
        'http://h.test/v1/models': () => redirect(302, '/v1/models/'),
        'http://h.test/v1/models/': () => Response.json({ data: [{ id: 'm' }] }),
      }, calls));
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.url), ['http://h.test/v1/models', 'http://h.test/v1/models/']);
    assert.deepEqual(calls[1].init.headers, { 'X-K': 's' });
  });

  it('refuses a cross-host redirect with a clear error and never contacts the target', async () => {
    const calls: Call[] = [];
    await assert.rejects(
      fetchWithoutCrossHostRedirects('http://h.test/v1/models', { headers: { 'X-K': 'header-secret' } },
        fakeFetch({ 'http://h.test/v1/models': () => redirect(302, 'http://user:pw@evil.test/steal?x=1') }, calls)),
      (err: unknown) =>
        err instanceof ProviderRedirectError &&
        /redirected \(302\) from http:\/\/h\.test to a different host \(http:\/\/evil\.test\)/.test(err.message) &&
        !err.message.includes('pw') && !err.message.includes('x=1'),
    );
    assert.deepEqual(calls.map((c) => c.url), ['http://h.test/v1/models']);
  });

  it('refuses an https → http downgrade on the same host', async () => {
    await assert.rejects(
      fetchWithoutCrossHostRedirects('https://h.test/v1/models', { headers: {} },
        fakeFetch({ 'https://h.test/v1/models': () => redirect(301, 'http://h.test/v1/models') }, [])),
      ProviderRedirectError,
    );
  });

  it(`stops after ${PROVIDER_MAX_REDIRECTS} same-host redirects; 3xx without Location is an error`, async () => {
    const calls: Call[] = [];
    await assert.rejects(
      fetchWithoutCrossHostRedirects('http://h.test/a', { headers: {} },
        fakeFetch({ 'http://h.test/a': () => redirect(307, '/a') }, calls)),
      /more than 3 times/,
    );
    assert.equal(calls.length, PROVIDER_MAX_REDIRECTS + 1);
    await assert.rejects(
      fetchWithoutCrossHostRedirects('http://h.test/a', { headers: {} },
        fakeFetch({ 'http://h.test/a': () => redirect(302) }, [])),
      /without a Location header/,
    );
  });
});

describe('S4 bounded body reads', () => {
  it('readBodyCapped stops at the cap and cancels an endless stream', async () => {
    const { stream, state } = countingStream(16 * 1024);
    const { text, truncated } = await readBodyCapped(new Response(stream), 64 * 1024);
    assert.equal(truncated, true);
    assert.equal(text.length, 64 * 1024);
    assert.ok(state.pulled <= 6, `pulled ${state.pulled} chunks`);
    assert.equal(state.cancelled, true);
  });

  it('readBodyCapped returns small bodies whole', async () => {
    const { text, truncated } = await readBodyCapped(new Response('héllo wörld'), 1024);
    assert.equal(text, 'héllo wörld');
    assert.equal(truncated, false);
  });

  it('readJsonCapped parses within the cap, refuses oversize by Content-Length or by stream', async () => {
    assert.deepEqual(await readJsonCapped(Response.json({ a: 1 }), 100), { a: 1 });
    await assert.rejects(
      readJsonCapped(new Response('{}', { headers: { 'content-length': '999999' } }), 100),
      ResponseTooLargeError,
    );
    const { stream, state } = countingStream(1024);
    await assert.rejects(readJsonCapped(new Response(stream), 4096), ResponseTooLargeError);
    assert.ok(state.pulled <= 6, `pulled ${state.pulled} chunks`);
  });
});
