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
  let patchRoute: (req: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;

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
      if (id === '@/lib/board-route-auth' || id.endsWith('/lib/board-route-auth')) {
        return { requireBoardIdentity: async () => ({ ok: true, value: true }) };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    lib = await import('./llm-providers');
    ({ PATCH: patchRoute } = (await import('../app/api/llm-providers/[id]/route')) as unknown as {
      PATCH: typeof patchRoute;
    });
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

  for (const name of ['constructor', 'toString', '__proto__']) {
    it(`built-in object name "${name}" is an ordinary header: blank is rejected on update and create`, async () => {
      // JSON.parse makes "__proto__" an own key, exactly as a request body would.
      const headers = JSON.parse(`{"Authorization": "", ${JSON.stringify(name)}: ""}`);
      await assert.rejects(() => lib.updateLlmProvider('prov-1', { headers }), new RegExp(`"${name}"`));
      assert.equal(lastSet, null);
      await assert.rejects(
        () => lib.createLlmProvider({ name: 'New', type: 'openai', baseURL: 'http://llm2.local/v1', headers: JSON.parse(`{${JSON.stringify(name)}: ""}`) }),
        { name: 'LlmProviderValidationError' },
      );
      assert.equal(inserted, null);
    });
  }

  it('built-in object names with values are saved as own headers (incl. __proto__)', async () => {
    const merged = lib.mergeWriteOnlyHeaders({}, JSON.parse('{"__proto__": "p", "toString": "t", "constructor": "c"}'));
    assert.deepEqual(Object.keys(merged).sort(), ['__proto__', 'constructor', 'toString']);
    assert.equal(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value, 'p');
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.equal(lib.mergeWriteOnlyHeaders({}, { toString: 't' }).toString, 't');
  });

  it('update: a whitespace-only value for a STORED header keeps the stored value', async () => {
    await lib.updateLlmProvider('prov-1', { headers: { Authorization: '   ' } });
    assert.deepEqual(lastSet?.headers, { Authorization: 'Bearer stored-value' });
  });

  it('update: headers null / array / non-string value → validation error; PATCH route → 400 (not 500)', async () => {
    for (const headers of [null, ['x'], 'x', { 'X-A': 1 }]) {
      await assert.rejects(
        () => lib.updateLlmProvider('prov-1', { headers: headers as unknown as Record<string, string> }),
        { name: 'LlmProviderValidationError' },
      );
    }
    assert.equal(lastSet, null);
    const res = await patchRoute(
      new Request('http://localhost/api/llm-providers/prov-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ headers: null }),
      }),
      { params: Promise.resolve({ id: 'prov-1' }) },
    );
    assert.equal(res.status, 400);
  });

  it('create: headers with values are saved', async () => {
    await lib.createLlmProvider({ name: 'New', type: 'openai', baseURL: 'http://llm2.local/v1', headers: { 'X-Team': 't1' } });
    assert.deepEqual(inserted?.headers, { 'X-Team': 't1' });
  });
});
