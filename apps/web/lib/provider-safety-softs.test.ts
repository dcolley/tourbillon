/**
 * #125 Test softs S1–S5 on the provider-safety helpers and the provider settings form
 * (S6 is the timeout/self-ending stream on the route-hardening endless-body test).
 * No network, no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_ERROR_BODY_MAX_BYTES,
  PROVIDER_INVALID_JSON_MESSAGE,
  ProviderInvalidJsonError,
  ProviderRedirectError,
  fetchWithoutCrossHostRedirects,
  providerErrorSnippet,
  readBodyCapped,
  readJsonCapped,
  scrubProviderSecrets,
} from './provider-safety';
import { apiKeySavePayload } from './llm-provider-form';

const KEY = 'sk-stored-key-0123456789';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('#125 S1: non-JSON success body', () => {
  it('readJsonCapped throws a fixed "provider returned invalid JSON", nothing of the body', async () => {
    for (const body of [`${KEY}`, `oops ${KEY} ${'x'.repeat(500)}`, '{"data": [', '']) {
      await assert.rejects(readJsonCapped(new Response(body), 1024 * 1024), (err: unknown) => {
        assert.ok(err instanceof ProviderInvalidJsonError);
        assert.equal((err as Error).message, PROVIDER_INVALID_JSON_MESSAGE);
        assert.ok(!(err as Error).message.includes(KEY.slice(0, 4)));
        return true;
      });
    }
  });

  it('valid JSON is still parsed', async () => {
    assert.deepEqual(await readJsonCapped(Response.json({ data: [{ id: 'm' }] }), 1024), { data: [{ id: 'm' }] });
  });
});

describe('#125 S2: secret cut at the byte cap', () => {
  it('padded body: the key prefix kept by the cap is dropped before scrub/trim', async () => {
    for (const kept of [1, 3, 6, KEY.length - 1]) {
      const body = await readBodyCapped(
        new Response(`${' '.repeat(PROVIDER_ERROR_BODY_MAX_BYTES - kept)}${KEY}`),
        PROVIDER_ERROR_BODY_MAX_BYTES,
      );
      assert.equal(body.truncated, true);
      assert.ok(body.text.endsWith(KEY.slice(0, kept)));
      const snippet = providerErrorSnippet(body, [KEY]);
      assert.ok(!snippet.includes(KEY.slice(0, Math.max(kept, 3))), `kept=${kept}: ${JSON.stringify(snippet)}`);
    }
  });

  it('untruncated bodies keep their tail (only scrubbed)', () => {
    assert.equal(providerErrorSnippet({ text: `error: ${KEY} end`, truncated: false }, [KEY]), 'error: [redacted] end');
    assert.equal(providerErrorSnippet({ text: 'plain error', truncated: false }, [KEY]), 'plain error');
  });
});

describe('#125 S3: redirect Location with userinfo', () => {
  it('same-host Location with user:pass@ is refused before any second request; password not in the error', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://admin:loc-pass-9@gw.test/v2/models' } });
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchWithoutCrossHostRedirects('http://gw.test/v1/models', { headers: {} }, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRedirectError);
        assert.match((err as Error).message, /username or password/);
        assert.ok(!(err as Error).message.includes('loc-pass-9'));
        return true;
      },
    );
    assert.deepEqual(seen, ['http://gw.test/v1/models']);
  });

  it('user-only Location (user@host) is refused too', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 307, headers: { location: 'http://someone@gw.test/v2/models' } })) as unknown as typeof fetch;
    await assert.rejects(
      fetchWithoutCrossHostRedirects('http://gw.test/v1/models', { headers: {} }, fetchImpl),
      (err: unknown) => err instanceof ProviderRedirectError && /username or password/.test((err as Error).message),
    );
  });
});

describe('#125 S4: case and base64 forms of a secret', () => {
  it('upper/lower-cased echoes of the key are scrubbed', () => {
    const out = scrubProviderSecrets(`got ${KEY.toUpperCase()} and ${KEY.toLowerCase()}`, [KEY]);
    assert.ok(!out.toLowerCase().includes(KEY.toLowerCase()), out);
    assert.equal(out, 'got [redacted] and [redacted]');
  });

  it('standalone base64 of the key (padded or not) is scrubbed', () => {
    const enc = b64(KEY);
    assert.equal(scrubProviderSecrets(`token=${enc}`, [KEY]), 'token=[redacted]');
    assert.ok(!scrubProviderSecrets(`token=${enc.replace(/=+$/, '')}`, [KEY]).includes(enc.slice(0, 12)));
  });

  it('base64 of user:key (a Basic credential without the "Basic " prefix) leaks no decodable key', () => {
    for (const user of ['u', 'us', 'usr', 'admin']) {
      const out = scrubProviderSecrets(`auth=${b64(`${user}:${KEY}`)}`, [KEY]);
      assert.match(out, /\[redacted\]/, out);
      for (const token of out.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? []) {
        assert.ok(!Buffer.from(token, 'base64').toString('latin1').includes(KEY.slice(0, 8)), `${user}: ${out}`);
      }
    }
  });

  it('short secrets get no base64 form (no over-redaction of ordinary text)', () => {
    assert.equal(scrubProviderSecrets('abc YWJj', ['abc']), '[redacted] YWJj');
  });
});

describe('#125 S5: clear API key from the settings form', () => {
  it('existing provider + "clear" → { clearApiKey: true } and no key', () => {
    assert.deepEqual(apiKeySavePayload({ apiKey: 'typed', clearApiKey: true }, false), { clearApiKey: true });
    assert.deepEqual(apiKeySavePayload({ apiKey: '', clearApiKey: true }, false), { clearApiKey: true });
  });

  it('typed key is sent trimmed; blank and not cleared sends nothing (keeps the stored key)', () => {
    assert.deepEqual(apiKeySavePayload({ apiKey: '  new-key ', clearApiKey: false }, false), { apiKey: 'new-key' });
    assert.deepEqual(apiKeySavePayload({ apiKey: '   ', clearApiKey: false }, false), {});
  });

  it('new provider: "clear" is meaningless and ignored', () => {
    assert.deepEqual(apiKeySavePayload({ apiKey: 'k', clearApiKey: true }, true), { apiKey: 'k' });
  });
});
