/** #106: provider header values are write-only and API keys never leave the server. */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const HEADER_SECRET = 'Bearer sk-header-secret-value-106';
const API_KEY = 'sk-api-key-secret-106';
type Row = Record<string, unknown>;
let rows: Row[] = [];
let lastSet: Row | null = null;

describe('#106 llm-providers public view', () => {
  let lib: typeof import('./llm-providers');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          llmProviders: { id: 'id' },
          agents: { providerId: 'providerId' },
          listLlmProviderRows: async () => rows,
          getLlmProviderRowById: async (rid: string) => rows.find((r) => r.id === rid),
          getDefaultLlmProviderRow: async () => rows.find((r) => r.isDefault),
          db: {
            update: () => ({
              set: (v: Row) => ({
                where: () => {
                  lastSet = v;
                  Object.assign(rows[0], v);
                  return { returning: async () => [rows[0]] };
                },
              }),
            }),
          },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), ne: () => ({}) };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./llm-providers');
  });

  beforeEach(() => {
    lastSet = null;
    rows = [
      {
        id: 'prov-1', name: 'LiteLLM', type: 'openai', baseURL: 'http://llm.local/v1', apiKey: API_KEY,
        headers: { Authorization: HEADER_SECRET, 'X-Team': 'team-secret-value' }, apiMode: 'chat',
        defaultModelSettings: {}, defaultModel: null, isDefault: true, stickiness: 'off',
        stickinessHeaderName: 'x-litellm-session-id', createdAt: new Date(0), updatedAt: new Date(0),
      },
    ];
  });

  it('list returns header names only and no API key', async () => {
    const [p] = await lib.listLlmProvidersPublic();
    const json = JSON.stringify(p);
    assert.ok(!json.includes(HEADER_SECRET), 'header value leaked');
    assert.ok(!json.includes('team-secret-value'), 'header value leaked');
    assert.ok(!json.includes(API_KEY), 'api key leaked');
    assert.deepEqual(Object.keys(p.headers).sort(), ['Authorization', 'X-Team']);
    assert.equal(p.hasApiKey, true);
  });

  it('get-one returns no header values and no API key', async () => {
    const json = JSON.stringify(await lib.getLlmProviderPublic('prov-1'));
    assert.ok(!json.includes(HEADER_SECRET) && !json.includes('team-secret-value') && !json.includes(API_KEY));
  });

  it('update: blank value keeps stored header, omitted header is removed, new value replaces', async () => {
    const res = await lib.updateLlmProvider('prov-1', { headers: { Authorization: '', 'X-New': 'v2' } });
    assert.deepEqual(lastSet?.headers, { Authorization: HEADER_SECRET, 'X-New': 'v2' });
    const json = JSON.stringify(res);
    assert.ok(!json.includes(HEADER_SECRET) && !json.includes('v2'), 'update response leaked header values');
  });
});
