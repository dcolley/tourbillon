/**
 * GET /api/models ?agentId=: when the agent has no provider row and its adapterConfig.baseURL
 * is on another host from the env base URL, the env API key is not attached and the response
 * is 409 with llm_provider_base_url_host_mismatch.
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

let rows: Row[] = [];
let agent: Row | null = null;
let fetched: Array<{ url: string; init: RequestInit }> = [];
type Handler = (url: string) => Response | Promise<Response>;
let handler: Handler = () => {
  throw new TypeError('no fetch handler');
};

describe('GET /api/models env credential host', () => {
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
            insert: () => ({ values: async () => {} }),
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
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete env[k];
      else env[k] = savedEnv[k];
    }
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    rows = [];
    agent = null;
    fetched = [];
    for (const k of ENV_KEYS) delete env[k];
    handler = () => Response.json({ data: [{ id: 'm1' }] });
  });

  it('refuses an agent with only a mismatched adapterConfig.baseURL (no provider row)', async () => {
    env.LLM_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-env-models-route-key';
    env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    agent = {
      id: 'agent-1', companyId: 'co-1', adapterType: 'openai',
      adapterConfig: { baseURL: 'https://evil.example/v1' },
      modelId: null, providerId: null,
    };
    const res = await GET(new NextRequest('http://localhost/api/models?agentId=agent-1'));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'llm_provider_base_url_host_mismatch');
    assert.match(body.error, /evil\.example/);
    assert.doesNotMatch(body.error, /sk-env-models/);
    assert.equal(fetched.length, 0);
  });

  it('matching host lists models with the Authorization header set', async () => {
    env.LLM_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-env-models-match-key';
    env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    agent = {
      id: 'agent-1', companyId: 'co-1', adapterType: 'openai',
      adapterConfig: { baseURL: 'https://api.openai.com/v1' },
      modelId: null, providerId: null,
    };
    const res = await GET(new NextRequest('http://localhost/api/models?agentId=agent-1'));
    assert.equal(res.status, 200);
    assert.equal(fetched.length, 1);
    const headers = fetched[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-env-models-match-key');
  });
});
