/**
 * #109 review S2: a NEW or renamed LLM-provider header must be submitted with a value. A blank
 * value has nothing stored to fall back on, and used to be saved as ''.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
let rows: Row[] = [];
let inserted: Row | null = null;
let lastSet: Row | null = null;

describe('LLM provider header values (new/renamed headers need a value)', () => {
  let lib: typeof import('./llm-providers');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') {
        return {
          llmProviders: { id: 'id', isDefault: 'isDefault' },
          agents: { providerId: 'providerId' },
          listLlmProviderRows: async () => rows,
          getLlmProviderRowById: async (rid: string) => rows.find((r) => r.id === rid),
          getDefaultLlmProviderRow: async () => rows.find((r) => r.isDefault),
          db: {
            insert: () => ({
              values: (v: Row) => {
                inserted = v;
                return { returning: async () => [{ ...rows[0], ...v, id: 'prov-new' }] };
              },
            }),
            update: () => ({
              set: (v: Row) => ({
                where: () => {
                  lastSet = v;
                  return { returning: async () => [{ ...rows[0], ...v }] };
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
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    inserted = null;
    lastSet = null;
    rows = [
      {
        id: 'prov-1', name: 'LiteLLM', type: 'openai', baseURL: 'http://llm.local/v1', apiKey: 'sk-x',
        headers: { Authorization: 'Bearer stored-value' }, apiMode: 'chat', defaultModelSettings: {},
        defaultModel: null, isDefault: true, stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id',
        createdAt: new Date(0), updatedAt: new Date(0),
      },
    ];
  });

  it('assertNewHeaderValues: blank or whitespace for a name not stored → error; stored names and real values pass', () => {
    assert.throws(() => lib.assertNewHeaderValues({}, { 'X-A': '' }), { name: 'LlmProviderValidationError' });
    assert.throws(() => lib.assertNewHeaderValues({}, { 'X-A': '   ' }), { name: 'LlmProviderValidationError' });
    assert.throws(() => lib.assertNewHeaderValues({ 'X-A': 'v' }, { 'X-B': '' }), /"X-B"/);
    lib.assertNewHeaderValues({}, { 'X-A': 'v' });
    lib.assertNewHeaderValues({ 'X-A': 'v' }, { 'X-A': '' });
  });

  it('update: a NEW header with a blank value is rejected and nothing is written', async () => {
    await assert.rejects(
      () => lib.updateLlmProvider('prov-1', { headers: { Authorization: 'Bearer stored-value', 'X-New': '' } }),
      { name: 'LlmProviderValidationError' },
    );
    assert.equal(lastSet, null);
  });

  it('update: a RENAMED header with a blank value is rejected and nothing is written', async () => {
    await assert.rejects(
      () => lib.updateLlmProvider('prov-1', { headers: { 'Authorization-Renamed': '' } }),
      { name: 'LlmProviderValidationError' },
    );
    assert.equal(lastSet, null);
  });

  it('update: a new header with a value is saved', async () => {
    await lib.updateLlmProvider('prov-1', { headers: { Authorization: 'Bearer stored-value', 'X-New': 'v2' } });
    assert.deepEqual(lastSet?.headers, { Authorization: 'Bearer stored-value', 'X-New': 'v2' });
  });

  it('create: a header with a blank value is rejected (nothing stored yet) and nothing is inserted', async () => {
    await assert.rejects(
      () => lib.createLlmProvider({ name: 'New', type: 'openai', baseURL: 'http://llm2.local/v1', headers: { 'X-Team': '' } }),
      { name: 'LlmProviderValidationError' },
    );
    assert.equal(inserted, null);
  });

  it('create: headers with values are saved', async () => {
    await lib.createLlmProvider({ name: 'New', type: 'openai', baseURL: 'http://llm2.local/v1', headers: { 'X-Team': 't1' } });
    assert.deepEqual(inserted?.headers, { 'X-Team': 't1' });
  });
});
