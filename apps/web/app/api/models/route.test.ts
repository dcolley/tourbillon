/**
 * GET /api/models with no providerId: registry default provider first, env only when there is no
 * default, and a clear JSON error (409/502/503) instead of a bare 502. The ?providerId= path is
 * unchanged. DB, auth and fetch are mocked: no real DB, no network.
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

const DEAD_ENV_URL = 'http://192.0.2.199:8000/v1'; // TEST-NET-1, never routed; fetch is mocked anyway

const litellm = (): Row => ({
  id: 'prov-litellm', name: 'LiteLLM', type: 'openai-compatible', baseURL: 'http://litellm.test/v1',
  apiKey: 'sk-litellm', headers: {}, apiMode: 'chat', isDefault: true, defaultModelSettings: {},
  defaultModel: null, stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id',
  createdAt: new Date(0), updatedAt: new Date(0),
});
const vllm = (): Row => ({
  ...litellm(), id: 'prov-vllm', name: 'vLLM-1', type: 'vllm', baseURL: 'http://vllm-1.test/v1',
  apiKey: null, isDefault: false,
});

let rows: Row[] = [];
let dbWrites = 0;
let dbReads = 0;
let authOk = true;
let fetched: Array<{ url: string; headers: Record<string, string> }> = [];
type Handler = (url: string) => Response | Promise<Response>;
let handler: Handler = () => {
  throw new TypeError('no fetch handler');
};

const unreachable = (code = 'ECONNREFUSED'): never => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
};
const modelsBody = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) });

describe('GET /api/models default provider', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let lib: typeof import('../../../lib/default-provider-models');

  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = env[k];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      return handler(url);
    }) as typeof fetch;

    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          llmProviders: { id: 'id', isDefault: 'isDefault' },
          agents: { id: 'id', companyId: 'companyId', providerId: 'providerId' },
          listLlmProviderRows: async () => {
            dbReads++;
            return rows;
          },
          getLlmProviderRowById: async (rid: string) => {
            dbReads++;
            return rows.find((r) => r.id === rid) ?? null;
          },
          getDefaultLlmProviderRow: async () => {
            dbReads++;
            return rows.find((r) => r.isDefault) ?? null;
          },
          db: {
            query: { agents: { findFirst: async () => null } },
            insert: () => {
              dbWrites++;
              throw new Error('unexpected insert');
            },
            update: () => {
              dbWrites++;
              throw new Error('unexpected update');
            },
            delete: () => {
              dbWrites++;
              throw new Error('unexpected delete');
            },
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), ne: () => ({}), and: () => ({}) };
      if (id === '@/lib/board-route-auth' || id.endsWith('/lib/board-route-auth')) {
        const guard = async () =>
          authOk
            ? { ok: true, value: true }
            : { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
        return { requireBoardIdentity: guard, requireBoardCompany: guard };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET } = (await import('./route')) as unknown as { GET: typeof GET });
    lib = await import('../../../lib/default-provider-models');
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
    dbWrites = 0;
    dbReads = 0;
    authOk = true;
    fetched = [];
    handler = () => {
      throw new TypeError('no fetch handler');
    };
  });

  const call = async (qs = '') => {
    const res = await GET(new NextRequest(`http://localhost/api/models${qs}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const urls = () => fetched.map((f) => f.url);

  // ------------------------------------------------------------- case 1: registry default exists
  describe('a registry default exists', () => {
    beforeEach(() => {
      rows = [vllm(), litellm()];
      // The Ops scenario: LLM_PROVIDER unset → lmstudio, pointing at a dead box. Must be ignored.
      env.LM_STUDIO_BASE_URL = DEAD_ENV_URL;
    });

    it('uses the default provider and ignores env', async () => {
      handler = (url) => (url === 'http://litellm.test/v1/models' ? modelsBody('z-model', 'a-model') : unreachable());
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.deepEqual(urls(), ['http://litellm.test/v1/models']);
      assert.equal(fetched[0].headers.Authorization, 'Bearer sk-litellm');
      assert.deepEqual(body, {
        models: [{ id: 'a-model' }, { id: 'z-model' }],
        provider: 'openai-compatible',
        baseURL: 'http://litellm.test/v1',
        providerId: 'prov-litellm',
        providerName: 'LiteLLM',
      });
      assert.equal(dbWrites, 0);
    });

    it('default unreachable → 503 naming the provider; no env fallback', async () => {
      handler = () => unreachable();
      const { status, body } = await call();
      assert.equal(status, 503);
      assert.equal(body.code, 'llm_provider_unreachable');
      assert.equal(body.source, 'registry');
      assert.equal(body.providerId, 'prov-litellm');
      assert.equal(body.providerName, 'LiteLLM');
      assert.equal(body.baseURL, 'http://litellm.test/v1');
      assert.match(String(body.error), /Could not reach the default LLM provider "LiteLLM".*ECONNREFUSED/);
      assert.deepEqual(urls(), ['http://litellm.test/v1/models']);
    });

    it('default timed out → 503 "timed out"', async () => {
      handler = () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      const { status, body } = await call();
      assert.equal(status, 503);
      assert.equal(body.code, 'llm_provider_unreachable');
      assert.match(String(body.error), /timed out/);
    });

    it('default answers with an HTTP error → 502 naming the provider and upstream status', async () => {
      handler = () => new Response('upstream boom', { status: 500 });
      const { status, body } = await call();
      assert.equal(status, 502);
      assert.equal(body.code, 'llm_provider_error');
      assert.equal(body.source, 'registry');
      assert.match(String(body.error), /"LiteLLM".*\(500\).*upstream boom/);
    });
  });

  // ------------------------------------------------------------- case 2: no default → env
  describe('no registry default (env fallback)', () => {
    beforeEach(() => {
      rows = [vllm()]; // a provider exists but none is default
    });

    it('lists from the env provider; non-default registry rows are not used', async () => {
      env.LM_STUDIO_BASE_URL = 'http://lmstudio.env.test/v1';
      handler = (url) =>
        url === 'http://lmstudio.env.test/v1/models' ? modelsBody('env-model') : new Response('', { status: 404 });
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.deepEqual(body.models, [{ id: 'env-model' }]);
      assert.equal(body.provider, 'lmstudio');
      assert.equal(body.baseURL, 'http://lmstudio.env.test/v1');
      assert.equal(body.providerId, undefined);
      assert.ok(urls().includes('http://lmstudio.env.test/v1/models'));
      assert.ok(!urls().some((u) => u.includes('vllm-1.test')));
      assert.equal(dbWrites, 0);
    });

    it('LLM_PROVIDER alone counts as configured', async () => {
      env.LLM_PROVIDER = 'openai-compatible';
      env.LLM_BASE_URL = 'http://compat.env.test/v1';
      handler = () => modelsBody('m');
      const { status, body } = await call();
      assert.equal(status, 200);
      assert.equal(body.provider, 'openai-compatible');
      assert.deepEqual(urls(), ['http://compat.env.test/v1/models']);
    });

    it('env provider unreachable (the Ops 192.168.x box) → 503 with source env', async () => {
      env.LM_STUDIO_BASE_URL = DEAD_ENV_URL;
      handler = () => unreachable('EHOSTUNREACH');
      const { status, body } = await call();
      assert.equal(status, 503);
      assert.equal(body.code, 'llm_provider_unreachable');
      assert.equal(body.source, 'env');
      assert.equal(body.provider, 'lmstudio');
      assert.equal(body.baseURL, DEAD_ENV_URL);
      assert.match(String(body.error), /env-configured LLM provider \(lmstudio at http:\/\/192\.0\.2\.199:8000\/v1\).*EHOSTUNREACH/);
    });
  });

  // ------------------------------------------------------------- case 3: nothing configured
  describe('nothing configured', () => {
    it('no default and no env → 409 llm_provider_not_configured; no upstream call', async () => {
      rows = [vllm()];
      const { status, body } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_not_configured');
      assert.equal(body.error, lib.NO_PROVIDER_MESSAGE);
      assert.deepEqual(fetched, []);
      assert.equal(dbWrites, 0);
    });

    it('blank env values do not count as configured', async () => {
      rows = [vllm()];
      env.LLM_PROVIDER = '  ';
      env.LM_STUDIO_BASE_URL = '';
      env.LLM_BASE_URL = '   ';
      const { status, body } = await call();
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_not_configured');
      assert.deepEqual(fetched, []);
    });
  });

  // ------------------------------------------------------------- providerId path unchanged
  describe('?providerId= path is unchanged', () => {
    beforeEach(() => {
      rows = [vllm(), litellm()];
      env.LM_STUDIO_BASE_URL = DEAD_ENV_URL;
    });

    it('lists the named provider, not the default', async () => {
      handler = (url) => (url === 'http://vllm-1.test/v1/models' ? modelsBody('qwen') : unreachable());
      const { status, body } = await call('?providerId=prov-vllm');
      assert.equal(status, 200);
      assert.deepEqual(urls(), ['http://vllm-1.test/v1/models']);
      assert.equal(body.providerId, 'prov-vllm');
      assert.equal(body.providerName, 'vLLM-1');
      assert.deepEqual(body.models, [{ id: 'qwen' }]);
    });

    it('unknown provider → 404 Provider not found', async () => {
      const { status, body } = await call('?providerId=nope');
      assert.equal(status, 404);
      assert.deepEqual(body, { error: 'Provider not found' });
      assert.deepEqual(fetched, []);
    });

    it('upstream failure keeps the old bare 502 { error } shape', async () => {
      handler = () => unreachable();
      const { status, body } = await call('?providerId=prov-vllm');
      assert.equal(status, 502);
      assert.deepEqual(body, { error: 'fetch failed' });
    });
  });

  it('auth guard still runs first: denied → its response, no DB or upstream call', async () => {
    authOk = false;
    rows = [litellm()];
    const { status } = await call();
    assert.equal(status, 401);
    assert.equal(dbReads, 0);
    assert.deepEqual(fetched, []);
  });

  describe('helpers', () => {
    it('envProviderConfigured: LLM_PROVIDER or a base-URL var for the resolved kind', () => {
      assert.equal(lib.envProviderConfigured({ provider: 'lmstudio' }), false);
      env.OPENAI_BASE_URL = 'http://o';
      assert.equal(lib.envProviderConfigured({ provider: 'lmstudio' }), false, 'OPENAI_BASE_URL does not configure lmstudio');
      assert.equal(lib.envProviderConfigured({ provider: 'openai' }), true);
      delete env.OPENAI_BASE_URL;
      env.LLM_BASE_URL = 'http://x';
      assert.equal(lib.envProviderConfigured({ provider: 'vllm' }), true);
      delete env.LLM_BASE_URL;
      env.LLM_PROVIDER = 'openai';
      assert.equal(lib.envProviderConfigured({ provider: 'openai' }), true);
    });

    it('isUnreachableError: network/timeout only, not HTTP errors', () => {
      assert.equal(lib.isUnreachableError(new TypeError('fetch failed')), true);
      assert.equal(lib.isUnreachableError(new DOMException('t', 'TimeoutError')), true);
      assert.equal(lib.isUnreachableError(new DOMException('a', 'AbortError')), true);
      assert.equal(lib.isUnreachableError(new Error('Could not list models from vllm (500)')), false);
      assert.equal(lib.isUnreachableError('fetch failed'), false);
    });
  });
});
