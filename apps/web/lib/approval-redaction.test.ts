/** #130 B1: the one approval redaction helper (key names, free-text scrubbing, display cap). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYLOAD_DISPLAY_CAP,
  REDACTION_UNAVAILABLE,
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

describe('approval redaction: more key names (Test S9)', () => {
  it('pwd, pass, x-auth, dsn and connectionString, any case/separator', () => {
    for (const k of ['pwd', 'PWD', 'dbPwd', 'pass', 'Pass', 'x-auth', 'X-Auth', 'dsn', 'DSN', 'sentryDsn', 'connectionString', 'connection_string', 'ConnectionString']) {
      assert.ok(isSensitiveKey(k), k);
    }
    for (const k of ['passenger', 'compass', 'bypass', 'passed', 'author']) assert.ok(!isSensitiveKey(k), k);
  });

  it('values under them are removed, in objects and in free text', () => {
    const r = createApprovalRedactor();
    const out = r.deep({ pwd: 'pwd-value-0001', Pass: 'pass-value-0002', 'X-Auth': 'xauth-value-0003', dsn: 'dsn-value-0004', connectionString: 'conn-value-0005' });
    assert.deepEqual(Object.values(out), ['[redacted]', '[redacted]', '[redacted]', '[redacted]', '[redacted]']);
    for (const [input, secret] of [
      ['pwd=pwd-text-0001 next', 'pwd-text-0001'],
      ['pass: pass-text-0002', 'pass-text-0002'],
      ['X-Auth: xauth-text-0003', 'xauth-text-0003'],
      ['SENTRY_DSN=dsn-text-0004', 'dsn-text-0004'],
      ['"connectionString": "conn-text-0005"', 'conn-text-0005'],
    ] as const) {
      const t = r.text(input);
      assert.ok(!t.includes(secret), t);
      assert.match(t, /\[redacted\]/);
    }
    assert.equal(r.text('bypass=1 compass: north'), 'bypass=1 compass: north');
  });
});

describe('approval redaction: URL userinfo of any scheme (Test S10)', () => {
  const r = createApprovalRedactor();
  for (const [input, secret, expected] of [
    ['db postgres://app:pg-pass-0001@db.example.test:5432/app ok', 'pg-pass-0001', 'db postgres://app:[redacted]@db.example.test:5432/app ok'],
    ['cache redis://:redis-pass-0002@cache.example.test:6379/0', 'redis-pass-0002', 'cache redis://:[redacted]@cache.example.test:6379/0'],
    ['ws wss://u:wss-pass-0003@ws.example.test/feed', 'wss-pass-0003', 'ws wss://u:[redacted]@ws.example.test/feed'],
    ['amqp://guest:p@ss-0004@mq.example.test', 'ss-0004', 'amqp://guest:[redacted]@mq.example.test'],
    ['git ssh://tok-userinfo-0005@git.example.test/repo', 'tok-userinfo-0005', 'git ssh://[redacted]@git.example.test/repo'],
  ] as const) {
    it(`scrubs ${secret}`, () => {
      const out = r.text(input);
      assert.ok(!out.includes(secret), out);
      assert.equal(out, expected);
      assert.equal(r.text(out), out, 'idempotent');
    });
  }
  it('URLs without userinfo and e-mail addresses are untouched', () => {
    const s = 'see postgres://db.example.test:5432/app and mail ops@example.test';
    assert.equal(r.text(s), s);
  });
});

describe('approval redaction: PEM blocks (Test S11)', () => {
  const r = createApprovalRedactor();
  it('whole block removed, any label, text around it kept', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpemBODY0001abc\nline2pemBODY\n-----END RSA PRIVATE KEY-----';
    const out = r.text(`key:\n${pem}\nthanks`);
    assert.ok(!out.includes('pemBODY'), out);
    assert.equal(out, 'key:\n[redacted]\nthanks');
    const cert = r.text('a -----BEGIN CERTIFICATE-----MIIcertBODY0002-----END CERTIFICATE----- b');
    assert.equal(cert, 'a [redacted] b');
  });
  it('JSON-escaped newlines and an unterminated block', () => {
    assert.ok(!r.text('{"k":"-----BEGIN PRIVATE KEY-----\\nescBODY0003\\n-----END PRIVATE KEY-----"}').includes('escBODY'));
    assert.equal(r.text('cut -----BEGIN OPENSSH PRIVATE KEY-----\nopenBODY0004 no end'), 'cut [redacted]');
  });
});

describe('approval redaction: vault values unavailable (#130 B3)', () => {
  it('freeText hides non-empty text; text() and deep() still scrub', () => {
    const r = createApprovalRedactor(['known-vault-value-123'], { vaultUnavailable: true });
    assert.equal(r.unavailable, true);
    assert.equal(r.freeText('anything at all'), REDACTION_UNAVAILABLE);
    assert.equal(r.freeText(''), '');
    assert.equal(r.text('apiKey=abcdefghijkl'), 'apiKey=[redacted]');
    const ok = createApprovalRedactor(['known-vault-value-123']);
    assert.equal(ok.unavailable, false);
    assert.equal(ok.freeText('vault known-vault-value-123'), 'vault [redacted]');
  });
});

describe('approval redaction: key=value pairs with secret-looking key names (PM)', () => {
  const r = createApprovalRedactor();
  const families = [
    'secret', 'client_secret', 'aws_secret_access_key', 'token', 'refresh-token', 'password', 'passwd', 'pwd',
    'api_key', 'apikey', 'api-key', 'x-api-key', 'private_key', 'auth', 'authorization', 'access_key', 'AWS_ACCESS_KEY',
    'Client-Secret', 'DB_PASSWORD',
  ];
  for (const key of families) {
    it(`${key}: value masked, key kept (=, :, JSON-ish, quoted)`, () => {
      const v = `kv-${key.replace(/[^a-z]/gi, '')}-0001`;
      assert.equal(r.text(`${key}=${v} next`), `${key}=[redacted] next`);
      assert.equal(r.text(`${key}: ${v}`), `${key}: [redacted]`);
      assert.equal(r.text(`{"${key}": "${v}", "n": 1}`), `{"${key}": "[redacted]", "n": 1}`);
      assert.equal(r.text(`${key}='${v}'`), `${key}='[redacted]'`);
    });
  }
  it('quoted values with spaces are masked whole', () => {
    assert.equal(r.text('password="correct horse battery" ok'), 'password="[redacted]" ok');
    assert.equal(r.text("client_secret: 'two words here'"), "client_secret: '[redacted]'");
    assert.equal(r.text('{"api_key":"a b c d"}'), '{"api_key":"[redacted]"}');
  });
  it('case-insensitive and inside longer text', () => {
    const out = r.text('set SECRET=abc-0001, Token: def-0002; and x-API-KEY=ghi-0003 done');
    assert.equal(out, 'set SECRET=[redacted], Token: [redacted]; and x-API-KEY=[redacted] done');
  });
  it('no false positives: token counts and unrelated keys stay', () => {
    const s = 'token_count=5 max_tokens: 4000 tokens=12 author=ann status: ok bypass=1 key_count=3 title: "a b"';
    assert.equal(r.text(s), s);
  });
  it('Authorization: Bearer/Basic still masked once, idempotent', () => {
    const out = r.text('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    assert.ok(!out.includes('dXNlcjpwYXNzd29yZA'), out);
    assert.equal(r.text(out), out);
    assert.equal(r.text('password=[redacted]'), 'password=[redacted]');
  });
  it('linear on a long unbroken string', () => {
    const big = 'a'.repeat(200_000);
    const t0 = Date.now();
    r.text(big);
    assert.ok(Date.now() - t0 < 1000);
  });
});

/**
 * Every rule must stay linear in the text length. A rule that is retried from every position of a
 * long run takes seconds on these 200k inputs; the linear rules take a few ms. The budget is
 * generous so a loaded machine doesn't flake, and still far below the slow case.
 */
const SPEED_BUDGET_MS = 400;
const LONG = 200_000;
const run = (unit: string) => unit.repeat(Math.ceil(LONG / unit.length)).slice(0, LONG);
function assertFast(r: ReturnType<typeof createApprovalRedactor>, input: string, label: string) {
  r.text('warm up a.b-c+d://x token=y');
  const t0 = performance.now();
  r.text(input);
  const ms = performance.now() - t0;
  assert.ok(ms < SPEED_BUDGET_MS, `${label}: ${ms.toFixed(0)} ms`);
}

describe('approval redaction: speed on long runs (#130 B4)', () => {
  const r = createApprovalRedactor(['known-vault-value-123']);
  for (const unit of ['a.', 'a-', 'a+', 'sk-', 'ab.cd-ef+gh', 'word.dotted.', 'eyJ-', 'xoxb-', 'a.b:', 'x://', 'a:a@']) {
    it(`200k-char "${unit}" run`, () => assertFast(r, run(unit), unit));
  }
  it('a 100 KB dotted value inside a whole approval stays fast', () => {
    const t0 = performance.now();
    r.deep({ title: 'x', summary: run('a.').slice(0, 100_000), nested: { note: run('sk-').slice(0, 100_000) } });
    assert.ok(performance.now() - t0 < SPEED_BUDGET_MS);
  });
  it('URL passwords are still found after a long or unusual scheme', () => {
    const long = `${'a.'.repeat(40)}db://app:long-scheme-pw-0001@db.example.test/x`;
    assert.ok(!r.text(long).includes('long-scheme-pw-0001'), r.text(long).slice(-60));
    assert.equal(r.text('1postgres://app:digit-pw-0002@db.example.test'), '1postgres://app:[redacted]@db.example.test');
  });
});

describe('approval redaction: speed of key=value scanning on long key-like runs (#130 B4/B5)', () => {
  const r = createApprovalRedactor();
  for (const unit of ['a', 'a-', 'a.', '--a', 'a=', 'a:', 'a ', 'a\t=\t', '-a=', 'a=b/', '"k": "', 'token="', 'token="\\', 'password=', '?token=a', 'max_tokens=1 ', 'Authorization: Token ']) {
    it(`200k-char "${unit}" run`, () => assertFast(r, run(unit), unit));
  }
  it('one 200k-char key before a separator', () => assertFast(r, `${'k'.repeat(LONG)}_token=value-0001`, 'long key'));
});

describe('approval redaction: key=value pairs, more forms (#130 B5)', () => {
  const r = createApprovalRedactor();
  const masked = (input: string, expected: string) => assert.equal(r.text(input), expected);

  it('a harmless pair right before a secret one does not hide it', () => {
    masked('go redirect=/cb?token=b5a-0001 now', 'go redirect=/cb?token=[redacted] now');
    masked('next:/x?api_key=b5a-0002', 'next:/x?api_key=[redacted]');
    masked('user:password=b5a-0003', 'user:password=[redacted]');
    masked('feed wss://h.example.test/p?token=b5a-0004', 'feed wss://h.example.test/p?token=[redacted]');
    masked('a=b/token=b5a-0005', 'a=b/token=[redacted]');
    masked('{"note": "use password=b5a-0006 here"}', '{"note": "use password=[redacted] here"}');
  });

  it('keys after -, -- or . are judged on their name', () => {
    masked('run --password=b5b-0001 --verbose', 'run --password=[redacted] --verbose');
    masked('--db-password=b5b-0002', '--db-password=[redacted]');
    masked('cfg .secret=b5b-0003', 'cfg .secret=[redacted]');
    masked('-token: b5b-0004', '-token: [redacted]');
    masked('cli --api-key=b5b-0005 -v=1', 'cli --api-key=[redacted] -v=1');
    masked('-p=1 --name=x', '-p=1 --name=x');
  });

  it('plural *_tokens keys keep numbers only', () => {
    masked('auth_tokens="b5c-0001"', 'auth_tokens="[redacted]"');
    masked('api_tokens=b5c-0002', 'api_tokens=[redacted]');
    masked("refresh_tokens: 'b5c-0003'", "refresh_tokens: '[redacted]'");
    const counts = 'max_tokens=4096 "input_tokens": 12 token_count=5 tokenLimit=9 auth_tokens=3 maxTokens: 100';
    assert.equal(r.text(counts), counts);
  });

  it('escaped quotes stay inside a quoted value; an unterminated quote runs to the end of the line', () => {
    masked('{"password": "ab\\" cd", "n": 1}', '{"password": "[redacted]", "n": 1}');
    masked("secret='it\\'s b5d-0001' ok", "secret='[redacted]' ok");
    masked('{"token": "ends in backslash\\\\", "n": 2}', '{"token": "[redacted]", "n": 2}');
    masked('password="b5d-0002 no close\nnext line', 'password="[redacted]\nnext line');
  });

  it('the key is the whole run before the separator, whatever its length or start', () => {
    masked('xtoken=mid-0001 mytoken: mid-0002', 'xtoken=[redacted] mytoken: [redacted]');
    masked(`${'x'.repeat(100)}_token=long-0001`, `${'x'.repeat(100)}_token=[redacted]`);
    masked(`token_${'x'.repeat(100)}=long-0002`, `token_${'x'.repeat(100)}=[redacted]`);
    masked(`a.${'b-'.repeat(60)}secret=long-0003`, `a.${'b-'.repeat(60)}secret=[redacted]`);
    const plain = `passport=AB12 bypass=1 compass:north abc.def=v ${'x'.repeat(100)}=v keyId=k1`;
    assert.equal(r.text(plain), plain);
  });

  it('Authorization with another scheme word masks the credential (Test S8)', () => {
    masked('Authorization: Token s8-cred-0001', 'Authorization: Token [redacted]');
    masked('authorization=ApiKey s8-cred-0002, x=1', 'authorization=ApiKey [redacted], x=1');
    masked('auth=s8-cred-0003 next', 'auth=[redacted] next');
    const bearer = r.text('Authorization: Bearer s8-cred-0004');
    assert.equal(bearer, 'Authorization: Bearer [redacted]');
    assert.equal(r.text(bearer), bearer);
  });
});
