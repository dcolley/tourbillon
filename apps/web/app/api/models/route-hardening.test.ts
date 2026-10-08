/**
 * Provider hardening on GET /api/models (#121 Test softs S1–S5, S7, S8), across the default,
 * ?providerId= and ?agentId= paths. DB, auth and fetch are mocked: no real DB, no network.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'LM_STUDIO_BASE_URL', 'OLLAMA_BASE_URL', 'OPENAI_BASE_URL',
  'LLM_API_KEY', 'LM_STUDIO_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_API_KEY', 'LLM_API_MODE',
] as const;
const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

const API_KEY = 'sk-stored-key-0123456789';
const HEADER_SECRET = 'team-header-secret-42';

const provider = (over: Row = {}): Row => ({
  id: 'prov-def', name: 'Gateway', type: 'openai-compatible', baseURL: 'http://gw.test/v1',
  apiKey: API_KEY, headers: { 'X-Team-Token': HEADER_SECRET }, apiMode: 'chat', isDefault: true,
  defaultModelSettings: {}, defaultModel: null, stickiness: 'off',
  stickinessHeaderName: 'x-litellm-session-id', createdAt: new Date(0), updatedAt: new Date(0),
  ...over,
});
const agentRow = (over: Row = {}): Row => ({
  id: 'agent-1', companyId: 'co-1', adapterType: 'harness_local', adapterConfig: {}, modelId: null,
  providerId: null, ...over,
});

let rows: Row[] = [];
let agent: Row | null = null;
let inserted: Row[] = [];
let fetched: Array<{ url: string; init: RequestInit }> = [];
let pulledChunks = 0;
type Handler = (url: string) => Response | Promise<Response>;
let handler: Handler = () => {
  throw new TypeError('no fetch handler');
};
const modelsBody = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) });
/** An upstream that echoes the request headers back in its error, like the Test stub. */
const echoHeaders = (status = 401, asJson = true) => (url: string) => {
  const headers = fetched.find((f) => f.url === url)?.init.headers as Record<string, string>;
  const body = asJson
    ? JSON.stringify({ error: 'unauthorized', received: headers })
    : `Error: bad auth\n  headers=${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('; ')}\n  at handler (/srv/app.js:1:1)`;
  return new Response(body, { status, headers: { 'content-type': asJson ? 'application/json' : 'text/plain' } });
};

describe('GET /api/models provider hardening', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = env[k];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push({ url, init: init ?? {} });
      return handler(url);
    }) as typeof fetch;

    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          llmProviders: { id: 'id', isDefault: 'isDefault' },
          agents: { id: 'id', companyId: 'companyId', providerId: 'providerId' },
          listLlmProviderRows: async () => rows,
          getLlmProviderRowById: async (rid: string) => rows.find((r) => r.id === rid) ?? null,
          getDefaultLlmProviderRow: async () => rows.find((r) => r.isDefault) ?? null,
          db: {
            query: { agents: { findFirst: async () => agent } },
            insert: () => ({
              values: async (v: Row) => {
                inserted.push(v);
                rows.push({ ...provider(), id: 'prov-seeded', ...v, headers: v.headers ?? {} });
              },
            }),
            update: () => {
              throw new Error('unexpected update');
            },
            delete: () => {
              throw new Error('unexpected delete');
            },
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), ne: () => ({}), and: () => ({}) };
      if (id === '@/lib/board-route-auth' || id.endsWith('/lib/board-route-auth')) {
        return {
          requireBoardIdentity: async () => ({ ok: true, value: true }),
          requireBoardCompany: async () => ({ ok: true, value: { id: 'co-1' } }),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET } = (await import('./route')) as unknown as { GET: typeof GET });
    Module.prototype.require = originalRequire;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete env[k];
      else env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete env[k];
    rows = [];
    agent = null;
    inserted = [];
    fetched = [];
    pulledChunks = 0;
    handler = () => {
      throw new TypeError('no fetch handler');
    };
  });

  const call = async (qs = '') => {
    const res = await GET(new NextRequest(`http://localhost/api/models${qs}`));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const urls = () => fetched.map((f) => f.url);
  const PATHS: Array<[string, () => void, string]> = [
    ['default', () => {}, ''],
    ['?providerId=', () => {}, '?providerId=prov-def'],
    ['?agentId=', () => { agent = agentRow({ providerId: 'prov-def' }); }, '?agentId=agent-1'],
  ];

  // ------------------------------------------------------------------ S1: no secret echo
  describe('S1: upstream error text never carries stored secrets', () => {
    for (const [label, setup, qs] of PATHS) {
      for (const asJson of [true, false]) {
        it(`${label} path, ${asJson ? 'JSON' : 'text/stack'} echo → no key, header value or Bearer in the response`, async () => {
          rows = [provider()];
          setup();
          handler = echoHeaders(401, asJson);
          const { status, text } = await call(qs);
          assert.equal(status, 502);
          assert.ok(!text.includes(API_KEY), text);
          assert.ok(!text.includes(HEADER_SECRET), text);
          assert.ok(!/Bearer\s+(?!\[redacted\])/.test(text), text);
          assert.match(text, /\[redacted\]/);
          // The secrets really were sent upstream (so the echo really contained them).
          const sent = fetched[0].init.headers as Record<string, string>;
          assert.equal(sent.Authorization, `Bearer ${API_KEY}`);
          assert.equal(sent['X-Team-Token'], HEADER_SECRET);
        });
      }
    }

    it('a secret straddling the 200-char snippet cut is redacted whole, not half-shown', async () => {
      rows = [provider()];
      handler = () => new Response(`${'x'.repeat(190)}${API_KEY}`, { status: 500 });
      const { text } = await call();
      assert.ok(!text.includes(API_KEY.slice(0, 10)), text);
    });
  });

  // ------------------------------------------------------------------ S4: bounded error read
  describe('S4: the error body read is bounded', () => {
    it('an endless 500 body is read only up to the cap, then cancelled', async () => {
      rows = [provider()];
      handler = () => {
        const chunk = new Uint8Array(16 * 1024).fill(0x61);
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            pulledChunks++;
            c.enqueue(chunk);
          },
        }), { status: 500 });
      };
      const { status, body } = await call();
      assert.equal(status, 502);
      assert.equal(body.code, 'llm_provider_error');
      assert.ok(pulledChunks <= 6, `pulled ${pulledChunks} × 16 KiB`);
      assert.match(String(body.error), /\(500\): a{200}$/);
    });

    it('an oversize success body is refused, not buffered', async () => {
      rows = [provider()];
      handler = () => new Response('{"data":[]}', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
      const { status, body } = await call();
      assert.equal(status, 502);
      assert.match(String(body.error), /exceeded \d+ bytes/);
    });
  });

  // ------------------------------------------------------------------ S3: redirects
  describe('S3: no automatic redirects; cross-host refused', () => {
    it('fetch is called with redirect: "manual"', async () => {
      rows = [provider()];
      handler = () => modelsBody('m');
      await call();
      assert.equal(fetched[0].init.redirect, 'manual');
    });

    for (const [label, setup, qs] of PATHS) {
      it(`${label} path: cross-host 302 → clear error; the target never sees the headers`, async () => {
        rows = [provider()];
        setup();
        handler = (url) =>
          url.startsWith('http://gw.test/')
            ? new Response(null, { status: 302, headers: { location: 'http://internal.test/admin/models' } })
            : modelsBody('stolen');
        const { status, body } = await call(qs);
        assert.equal(status, 502);
        assert.match(String(body.error), /different host \(http:\/\/internal\.test\)/);
        assert.ok(!urls().some((u) => u.includes('internal.test')), String(urls()));
      });
    }

    it('same-host redirect is followed (bounded) and lists models', async () => {
      rows = [provider()];
      handler = (url) =>
        url === 'http://gw.test/v1/models'
          ? new Response(null, { status: 308, headers: { location: '/v2/models' } })
          : modelsBody('m2');
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.deepEqual(body.models, [{ id: 'm2' }]);
      assert.deepEqual(urls(), ['http://gw.test/v1/models', 'http://gw.test/v2/models']);
    });
  });

  // ------------------------------------------------------------------ S2: URL credentials
  describe('S2: credentials and query strings in base URLs', () => {
    it('registry default with user:pass@ → 409 llm_provider_base_url_credentials, password not echoed, no fetch', async () => {
      rows = [provider({ baseURL: 'http://admin:hunter2@gw.test/v1' })];
      const { status, body, text } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_base_url_credentials');
      assert.equal(body.baseURL, 'http://gw.test/v1');
      assert.ok(!text.includes('hunter2') && !text.includes('admin:'), text);
      assert.deepEqual(fetched, []);
    });

    it('env base URL with user:pass@ → 409 with source env; nothing seeded', async () => {
      env.LM_STUDIO_BASE_URL = 'http://u:envpass@lm.env.test/v1';
      const { status, body, text } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_base_url_credentials');
      assert.equal(body.source, 'env');
      assert.ok(!text.includes('envpass'), text);
      assert.deepEqual(inserted, []);
      assert.deepEqual(fetched, []);
    });

    it('?providerId= and ?agentId= with user:pass@ → 409 { error, code }', async () => {
      rows = [provider({ baseURL: 'http://admin:hunter2@gw.test/v1' })];
      agent = agentRow({ providerId: 'prov-def' });
      for (const qs of ['?providerId=prov-def', '?agentId=agent-1']) {
        const { status, body, text } = await call(qs);
        assert.equal(status, 409, qs);
        assert.equal(body.code, 'llm_provider_base_url_credentials');
        assert.ok(!text.includes('hunter2'), text);
      }
      assert.deepEqual(fetched, []);
    });

    it('query string: kept on the upstream call (after /models), stripped from success and error bodies', async () => {
      rows = [provider({ baseURL: 'http://gw.test/v1?api_key=qs-secret-123' })];
      handler = () => modelsBody('m');
      const ok = await call();
      assert.equal(ok.status, 200);
      assert.deepEqual(urls(), ['http://gw.test/v1/models?api_key=qs-secret-123']);
      assert.equal(ok.body.baseURL, 'http://gw.test/v1');
      assert.ok(!ok.text.includes('qs-secret-123'));

      handler = () => unreachableErr();
      const bad = await call();
      assert.equal(bad.status, 503);
      assert.equal(bad.body.baseURL, 'http://gw.test/v1');
      assert.ok(!bad.text.includes('qs-secret-123'), bad.text);

      handler = (url) => new Response(`no such route ${url}`, { status: 404 });
      const echoed = await call();
      assert.equal(echoed.status, 502);
      assert.ok(!echoed.text.includes('qs-secret-123'), echoed.text);
    });
  });

  // ------------------------------------------------------------------ S7: agent path order
  describe('S7: ?agentId= uses the registry default before env', () => {
    it('agent without providerId → registry default (env ignored)', async () => {
      rows = [provider()];
      agent = agentRow({ providerId: null });
      env.LM_STUDIO_BASE_URL = 'http://lm.env.test/v1';
      handler = (url) => (url === 'http://gw.test/v1/models' ? modelsBody('gw-model') : modelsBody('env-model'));
      const { status, body } = await call('?agentId=agent-1');
      assert.equal(status, 200);
      assert.equal(body.providerId, 'prov-def');
      assert.deepEqual(body.models, [{ id: 'gw-model' }]);
      assert.ok(!urls().some((u) => u.includes('lm.env.test')));
    });

    it('agent with its own providerId → that provider, not the default', async () => {
      rows = [provider(), provider({ id: 'prov-own', name: 'Own', baseURL: 'http://own.test/v1', isDefault: false })];
      agent = agentRow({ providerId: 'prov-own' });
      handler = () => modelsBody('own-model');
      const { body } = await call('?agentId=agent-1');
      assert.equal(body.providerId, 'prov-own');
      assert.deepEqual(urls(), ['http://own.test/v1/models']);
    });

    it('no registry default → env (unchanged fallback)', async () => {
      rows = [provider({ isDefault: false })];
      agent = agentRow({ providerId: null });
      env.LM_STUDIO_BASE_URL = 'http://lm.env.test/v1';
      handler = (url) => (url.startsWith('http://lm.env.test/v1/models') ? modelsBody('env-model') : new Response('', { status: 404 }));
      const { status, body } = await call('?agentId=agent-1');
      assert.equal(status, 200);
      assert.equal(body.providerId, undefined);
      assert.deepEqual(body.models, [{ id: 'env-model' }]);
    });
  });

  // ------------------------------------------------------------------ S5 + S8: auto-create
  describe('S5/S8: empty-registry auto-create', () => {
    it('env set → the default row is seeded from env (trimmed), then listed from the registry', async () => {
      env.LM_STUDIO_BASE_URL = '  http://lm.env.test/v1/  ';
      env.LM_STUDIO_API_KEY = '  env-key  ';
      handler = (url) => (url === 'http://lm.env.test/v1/models' ? modelsBody('seeded-model') : new Response('', { status: 404 }));
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].name, 'Default (LM Studio)');
      assert.equal(inserted[0].type, 'lmstudio');
      assert.equal(inserted[0].baseURL, 'http://lm.env.test/v1');
      assert.equal(inserted[0].apiKey, 'env-key');
      assert.equal(inserted[0].isDefault, true);
      assert.equal(body.providerId, 'prov-seeded');
      assert.deepEqual(body.models, [{ id: 'seeded-model' }]);
    });

    it('LLM_PROVIDER alone counts as set → seeds that kind at its default URL', async () => {
      env.LLM_PROVIDER = 'ollama';
      handler = () => modelsBody('o');
      await call();
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].type, 'ollama');
    });

    it('no env → nothing is created and the answer is 409 not configured (no phantom LM Studio row)', async () => {
      const { status, body } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_not_configured');
      assert.deepEqual(inserted, []);
      assert.deepEqual(fetched, []);
    });

    it('whitespace-only env → nothing is created, 409', async () => {
      env.LLM_PROVIDER = '   ';
      env.LM_STUDIO_BASE_URL = '  ';
      env.LLM_BASE_URL = '';
      const { status, body } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_not_configured');
      assert.deepEqual(inserted, []);
    });

    it('LLM_PROVIDER set but its base URL var is whitespace → counts as unset, seeds at the kind default', async () => {
      // #143 S4: blank/whitespace base URL env matches unset (same as envSet), not an empty
      // baseURL that the SDK would reject. Same outcome as "LLM_PROVIDER alone".
      env.LLM_PROVIDER = 'lmstudio';
      env.LM_STUDIO_BASE_URL = '   ';
      handler = () => modelsBody('m');
      const { status } = await call();
      assert.equal(status, 200);
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].type, 'lmstudio');
      assert.equal(inserted[0].baseURL, 'http://localhost:1234/v1');
    });

    it('registry not empty → no auto-create even with env set', async () => {
      rows = [provider({ isDefault: false })];
      env.LM_STUDIO_BASE_URL = 'http://lm.env.test/v1';
      handler = () => modelsBody('m');
      await call();
      assert.deepEqual(inserted, []);
    });
  });
});

function unreachableErr(): never {
  throw Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}
