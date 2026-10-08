/** #130 B1: the one approval redaction helper (key names, free-text scrubbing, display cap). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYLOAD_DISPLAY_CAP,
  collectValuesUnderSensitiveKeys,
  createApprovalRedactor,
  isSensitiveKey,
} from './approval-redaction';

describe('approval redaction: key names', () => {
  it('credential-like keys, any case/separator', () => {
    for (const k of [
      'token', 'Token', 'apiKey', 'api_key', 'API-KEY', 'x-api-key', 'X-Api-Key', 'password', 'secret',
      'resumeToken', 'hitlyResumeToken', 'authorization', 'Authorization', 'accessToken', 'refresh_token',
      'clientSecret', 'client_secret', 'privateKey', 'cookie', 'Set-Cookie', 'credentials', 'auth', 'jwt',
      'encryptedValue', 'secrets', 'mcpCredentials', 'tavilyApiKey',
    ]) assert.ok(isSensitiveKey(k), k);
    for (const k of ['title', 'summary', 'urlKey', 'issueIds', 'author', 'priorStatuses', 'status', 'keyId', 'monkey']) {
      assert.ok(!isSensitiveKey(k), k);
    }
  });

  it('nested in objects and arrays; key names and non-secret values stay; token counts stay', () => {
    const r = createApprovalRedactor();
    const out = r.deep({
      title: 'Hire',
      token: 'tok-aaaaaaaaaaaa',
      list: [{ apiKey: 'key-bbbbbbbbbbbb' }, { deeper: { PASSWORD: 'pw-cccccccccc', 'x-api-key': 'xk-dddddddddd' } }],
      headers: { Authorization: 'Bearer eeeeeeeeeeee', Cookie: 'sid=ffffffffff' },
      secrets: { GH_TOKEN: 'ghp_x', nested: ['s1-gggggggggg', 42] },
      pin: 1234,
      maxTokens: 4096,
      usage: { inputTokens: 10, outputTokens: 20 },
      hasToken: true,
      emptySecret: '',
    }) as Record<string, any>;
    assert.equal(out.title, 'Hire');
    assert.equal(out.token, '[redacted]');
    assert.equal(out.list[0].apiKey, '[redacted]');
    assert.equal(out.list[1].deeper.PASSWORD, '[redacted]');
    assert.equal(out.list[1].deeper['x-api-key'], '[redacted]');
    assert.equal(out.headers.Authorization, '[redacted]');
    assert.equal(out.headers.Cookie, '[redacted]');
    assert.deepEqual(out.secrets, { GH_TOKEN: '[redacted]', nested: ['[redacted]', '[redacted]'] });
    assert.equal(out.pin, '[redacted]');
    assert.equal(out.maxTokens, 4096);
    assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 20 });
    assert.equal(out.hasToken, true);
    assert.equal(out.emptySecret, '');
  });

  it('dates and the input are left alone', () => {
    const at = new Date('2026-10-08T09:00:00Z');
    const input = { at, token: 'tok-aaaaaaaaaaaa' };
    const out = createApprovalRedactor().deep(input);
    assert.equal(out.at, at);
    assert.equal(input.token, 'tok-aaaaaaaaaaaa');
  });
});

describe('approval redaction: free text', () => {
  const r = createApprovalRedactor(['known-vault-value-123', 'prov key/with+chars']);
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abcdefghijklmnop"', 'abcdefghijklmnop'],
    ['Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['callback https://hooks.example.test/cb?token=urltok-0001&x=1#frag', 'urltok-0001'],
    ['https://user:pw-in-url-0002@example.test/x', 'pw-in-url-0002'],
    ['apiKey=assign-0003 then', 'assign-0003'],
    ['{"password":"jsonpw-0004"}', 'jsonpw-0004'],
    ['x-api-key: hdr-0005', 'hdr-0005'],
    ["resumeToken: 'resume-0006'", 'resume-0006'],
    ['client_secret=cs-0007&grant=1', 'cs-0007'],
    ['Cookie: sid=ck-0008; other=ck-0009', 'ck-0009'],
    ['leaked sk-proj0123456789abcdefABCDEF', 'sk-proj0123456789abcdefABCDEF'],
    ['ghp_0123456789abcdefghijABCDEFGHIJ used', 'ghp_0123456789abcdefghijABCDEFGHIJ'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz', 'eyJzdWIiOiIxMjM0In0'],
    ['vault says known-vault-value-123!', 'known-vault-value-123'],
    ['escaped "known-vault-value-123" and prov%20key%2Fwith%2Bchars', 'prov%20key%2Fwith%2Bchars'],
    ['raw prov key/with+chars here', 'prov key/with+chars'],
  ];
  for (const [input, secret] of cases) {
    it(`scrubs ${secret}`, () => {
      const out = r.text(input);
      assert.ok(!out.includes(secret), out);
      // URLs lose userinfo/query/fragment outright (#125 redactUrlsInText); the rest get a marker.
      if (!input.includes('://')) assert.match(out, /\[redacted\]/);
    });
  }

  it('ordinary text is untouched; short known values are ignored', () => {
    const r2 = createApprovalRedactor(['short', 'admin']);
    const s = 'Hire a contractor for the admin panel (TOUR-12), budget 400 tokens';
    assert.equal(r2.text(s), s);
  });

  it('strings in keys are scrubbed too', () => {
    const out = createApprovalRedactor(['known-vault-value-123']).deep({ 'known-vault-value-123': 1 });
    assert.deepEqual(Object.keys(out), ['[redacted]']);
  });
});

describe('approval redaction: display cap (Test S1)', () => {
  it('1,500-deep nesting is cut at maxDepth with a marker, quickly', () => {
    let deep: unknown = { leaf: 'bottom' };
    for (let i = 0; i < 1500; i++) deep = { n: deep };
    const t0 = Date.now();
    const { value, truncated } = createApprovalRedactor().capped(deep);
    const json = JSON.stringify(value, null, 2);
    assert.ok(truncated);
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(json.length < 2_000, `${json.length}`);
    assert.match(json, /\[truncated: nested deeper than 12 levels\]/);
  });

  it('5 MB payload is cut to the size budget; long strings, arrays and objects get markers', () => {
    const big = {
      blob: 'x'.repeat(5_000_000),
      list: Array.from({ length: 1000 }, (_, i) => `item-${i}`),
      obj: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])),
      many: Array.from({ length: 100 }, () => 'y'.repeat(1_000)),
    };
    const { value, truncated } = createApprovalRedactor().capped(big);
    const json = JSON.stringify(value);
    assert.ok(truncated);
    assert.ok(json.length < PAYLOAD_DISPLAY_CAP.maxTotalChars * 1.5, `${json.length}`);
    assert.match(json, /\[truncated: 4998000 more chars\]/);
    assert.match(json, /\[truncated: 900 more items\]/);
    assert.match(json, /\[truncated: 400 more keys\]/);
    assert.match(json, /\[truncated: display limit reached\]/);
  });

  it('a long string is scrubbed before it is cut (no half secret left behind)', () => {
    const secret = 'known-vault-value-123';
    const s = `${'a'.repeat(PAYLOAD_DISPLAY_CAP.maxStringChars - 5)}${secret}`;
    const { value } = createApprovalRedactor([secret]).capped({ s });
    assert.ok(!JSON.stringify(value).includes('known-'), JSON.stringify(value).slice(-80));
  });

  it('small payloads are not marked truncated', () => {
    const { value, truncated } = createApprovalRedactor().capped({ title: 'x', n: [1, 2] });
    assert.equal(truncated, false);
    assert.deepEqual(value, { title: 'x', n: [1, 2] });
  });
});

describe('approval redaction: values under credential keys', () => {
  it('collected at any depth (iterative), short ones skipped', () => {
    let deep: unknown = { resumeToken: 'deep-resume-000001' };
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const found = collectValuesUnderSensitiveKeys({
      a: { token: 'tok-aaaaaaaaaaaa', title: 'not-a-secret-value' },
      secrets: { X: 'sec-bbbbbbbbbb', Y: 'short' },
      deep,
    });
    assert.deepEqual(found.sort(), ['deep-resume-000001', 'sec-bbbbbbbbbb', 'tok-aaaaaaaaaaaa']);
  });
});
