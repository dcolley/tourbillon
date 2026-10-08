/**
 * Provider hardening on the provider API (#121 Test softs):
 * - when an update moves a provider to another host (or https → http), the stored API key and
 *   header values are not carried over silently: they must be re-entered (or cleared) in the
 *   same request, else 409 `llm_provider_secrets_reentry_required` and nothing is written;
 * - S2: base URLs with user:pass@ are refused on create/update (409
 *   `llm_provider_base_url_credentials`), and base URLs are returned without userinfo/query;
 *   sending that redacted URL back keeps the stored one.
 * DB and auth are mocked: no real DB.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
let rows: Row[] = [];
let inserted: Row | null = null;
let sets: Row[] = [];

const KEY = 'sk-stored';
const HDR = 'stored-team-token';

describe('LLM provider update: host change needs secrets re-entered; URL credentials refused', () => {
  let lib: typeof import('./llm-providers');
  type RouteCtx = { params: Promise<{ id: string }> };
  let patchRoute: (req: Request, c: RouteCtx) => Promise<Response>;
  let postRoute: (req: Request) => Promise<Response>;
  let getRoute: (req: Request, c: RouteCtx) => Promise<Response>;

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
              set: (v: Row) => {
                sets.push(v);
                return { where: () => ({ returning: async () => [{ ...rows[0], ...v }] }) };
              },
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
    ({ PATCH: patchRoute, GET: getRoute } = (await import('../app/api/llm-providers/[id]/route')) as unknown as {
      PATCH: typeof patchRoute;
      GET: typeof getRoute;
    });
    ({ POST: postRoute } = (await import('../app/api/llm-providers/route')) as unknown as { POST: typeof postRoute });
    Module.prototype.require = originalRequire;
  });

  const stored = (over: Row = {}): Row => ({
    id: 'prov-1', name: 'Gateway', type: 'openai', baseURL: 'https://gw.test/v1', apiKey: KEY,
    headers: { 'X-Team-Token': HDR }, apiMode: 'chat', defaultModelSettings: {}, defaultModel: null,
    isDefault: true, stickiness: 'off', stickinessHeaderName: 'x-litellm-session-id',
    createdAt: new Date(0), updatedAt: new Date(0), ...over,
  });

  beforeEach(() => {
    inserted = null;
    sets = [];
    rows = [stored()];
  });

  const patch = async (body: Row) => {
    const res = await patchRoute(
      new Request('http://localhost/api/llm-providers/prov-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: 'prov-1' }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  // What the settings UI sends for an unchanged header: its name with a blank value.
  const uiHeaders = { 'X-Team-Token': '' };

  describe('host change', () => {
    it('new host, key and header left blank (UI round-trip) → 409 reentry_required naming both; nothing written', async () => {
      const { status, body } = await patch({ baseURL: 'https://evil.test/v1', headers: uiHeaders, isDefault: true });
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_secrets_reentry_required');
      assert.match(String(body.error), /different host \(https:\/\/gw\.test\/v1 → https:\/\/evil\.test\/v1\)/);
      assert.match(String(body.error), /the API key/);
      assert.match(String(body.error), /header "X-Team-Token"/);
      assert.ok(!String(body.error).includes(KEY) && !String(body.error).includes(HDR));
      assert.deepEqual(sets, [], 'no DB write at all (not even clearing other defaults)');
    });

    it('new host, new key but the stored header left blank → 409 naming only the header', async () => {
      const { status, body } = await patch({ baseURL: 'https://evil.test/v1', apiKey: 'sk-new', headers: uiHeaders });
      assert.equal(status, 409);
      assert.doesNotMatch(String(body.error), /API key/);
      assert.match(String(body.error), /header "X-Team-Token"/);
      assert.deepEqual(sets, []);
    });

    it('new host with headers omitted entirely → 409 (stored headers would be carried over)', async () => {
      const { status, body } = await patch({ baseURL: 'https://evil.test/v1', apiKey: 'sk-new' });
      assert.equal(status, 409);
      assert.match(String(body.error), /header "X-Team-Token"/);
      assert.deepEqual(sets, []);
    });

    it('new host with the key and header values re-entered → saved with the new values', async () => {
      const { status } = await patch({ baseURL: 'https://new.test/v1', apiKey: 'sk-new', headers: { 'X-Team-Token': 'new-token' } });
      assert.equal(status, 200);
      const write = sets.at(-1)!;
      assert.equal(write.baseURL, 'https://new.test/v1');
      assert.equal(write.apiKey, 'sk-new');
      assert.deepEqual(write.headers, { 'X-Team-Token': 'new-token' });
    });

    it('new host with the key cleared and the header removed → saved (nothing carried over)', async () => {
      const { status } = await patch({ baseURL: 'https://new.test/v1', clearApiKey: true, headers: {} });
      assert.equal(status, 200);
      const write = sets.at(-1)!;
      assert.equal(write.apiKey, null);
      assert.deepEqual(write.headers, {});
    });

    it('port change and https → http downgrade count as a host change; same host, new path does not', async () => {
      for (const baseURL of ['https://gw.test:8443/v1', 'http://gw.test/v1']) {
        sets = [];
        const { status, body } = await patch({ baseURL, headers: uiHeaders });
        assert.equal(status, 409, baseURL);
        assert.equal(body.code, 'llm_provider_secrets_reentry_required');
        assert.deepEqual(sets, []);
      }
      const same = await patch({ baseURL: 'https://gw.test/v2', headers: uiHeaders });
      assert.equal(same.status, 200);
      assert.equal(sets.at(-1)!.baseURL, 'https://gw.test/v2');
      assert.deepEqual(sets.at(-1)!.headers, { 'X-Team-Token': HDR }, 'same host keeps stored values');
      assert.equal('apiKey' in sets.at(-1)!, false);
    });

    it('http → https upgrade on the same host keeps stored secrets', async () => {
      rows = [stored({ baseURL: 'http://gw.test/v1' })];
      const { status } = await patch({ baseURL: 'https://gw.test/v1', headers: uiHeaders });
      assert.equal(status, 200);
    });

    it('a provider with no stored key or headers can move hosts freely', async () => {
      rows = [stored({ apiKey: null, headers: {} })];
      const { status } = await patch({ baseURL: 'https://other.test/v1' });
      assert.equal(status, 200);
    });

    it('malformed headers on a host change are still a plain 400 (validated first), nothing written', async () => {
      const { status, body } = await patch({ baseURL: 'https://evil.test/v1', headers: null });
      assert.equal(status, 400);
      assert.equal(body.code, undefined);
      assert.deepEqual(sets, []);
    });

    it('missingSecretsForHostChange: unit cases', () => {
      const ex = { apiKey: KEY, headers: { A: 'a', B: 'b' } };
      assert.deepEqual(lib.missingSecretsForHostChange(ex, {}), ['the API key', 'header "A"', 'header "B"']);
      assert.deepEqual(lib.missingSecretsForHostChange(ex, { apiKey: '  ', headers: { A: 'x', B: ' ' } }), ['the API key', 'header "B"']);
      assert.deepEqual(lib.missingSecretsForHostChange(ex, { clearApiKey: true, headers: { A: 'x' } }), []);
      assert.deepEqual(lib.missingSecretsForHostChange({ apiKey: null, headers: {} }, {}), []);
    });
  });

  describe('S2: credentials in the base URL', () => {
    it('PATCH with user:pass@ → 409 llm_provider_base_url_credentials; nothing written', async () => {
      const { status, body } = await patch({ baseURL: 'https://u:p4ss@gw.test/v1' });
      assert.equal(status, 409);
      assert.equal(body.code, 'llm_provider_base_url_credentials');
      assert.ok(!String(body.error).includes('p4ss'));
      assert.deepEqual(sets, []);
    });

    it('POST with user:pass@ → 409; nothing inserted', async () => {
      const res = await postRoute(new Request('http://localhost/api/llm-providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', type: 'openai', baseURL: 'http://u:p4ss@h.test/v1' }),
      }));
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as Row).code, 'llm_provider_base_url_credentials');
      assert.equal(inserted, null);
    });

    it('other validation errors stay 400 without a code', async () => {
      const { status, body } = await patch({ baseURL: 'ftp://gw.test/v1' });
      assert.equal(status, 400);
      assert.equal(body.code, undefined);
      assert.match(String(body.error), /http or https/);
    });

    it('GET returns the base URL without its query string or userinfo', async () => {
      rows = [stored({ baseURL: 'https://gw.test/v1?api_key=qs-secret' })];
      const res = await getRoute(new Request('http://localhost/api/llm-providers/prov-1'), { params: Promise.resolve({ id: 'prov-1' }) });
      const body = (await res.json()) as { provider: Row };
      assert.equal(body.provider.baseURL, 'https://gw.test/v1');
      assert.ok(!JSON.stringify(body).includes('qs-secret'));
      const list = await lib.listLlmProvidersPublic();
      assert.equal(list[0].baseURL, 'https://gw.test/v1');
    });

    it('saving the redacted URL back unchanged keeps the stored URL (query key not lost)', async () => {
      rows = [stored({ baseURL: 'https://gw.test/v1?api_key=qs-secret' })];
      const { status } = await patch({ baseURL: 'https://gw.test/v1', headers: uiHeaders, name: 'Renamed' });
      assert.equal(status, 200);
      const write = sets.at(-1)!;
      assert.equal('baseURL' in write, false, 'baseURL not rewritten');
      assert.equal(write.name, 'Renamed');
    });

    it('a legacy stored URL with user:pass@ saved back redacted is cleaned up (same host, no re-entry)', async () => {
      rows = [stored({ baseURL: 'https://u:p@gw.test/v1' })];
      const { status } = await patch({ baseURL: 'https://gw.test/v1', headers: uiHeaders });
      assert.equal(status, 200);
      assert.equal(sets.at(-1)!.baseURL, 'https://gw.test/v1');
    });
  });
});
