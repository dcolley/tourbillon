/**
 * #112: the vault OAuth state HMAC fails closed. With BETTER_AUTH_SECRET unset or a known
 * public default, both starting (authorize) and finishing (callback) the flow are refused with
 * a relative /settings redirect + error flag, and one server error names the env var (never a
 * value). A real secret still completes the authorize → callback pre-exchange path (nonce cookie
 * + durable consume mocked).
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const env = process.env as Record<string, string | undefined>;
const REAL_SECRET = 'real-better-auth-secret-for-oauth-tests-0123456789';
const DEFAULTS = ['change-me-in-production', 'change-me-in-production-use-openssl-rand-base64-32'];
const NOT_CONFIGURED = '/settings?oauth_error=oauth_state_secret_not_configured';
const KEY_INFO = 'tourbillon-vault-oauth-state-v2';

let errors: string[] = [];
const realConsoleError = console.error;
const nonces = new Set<string>();

function derivedKey(secret: string) {
  return createHmac('sha256', secret).update(KEY_INFO).digest();
}

/** A state forged with a raw (non-derived) secret — must be rejected under derived-key verify. */
function stateSignedWithRaw(secret: string, payload = { v: 2, serverId: 'github-mcp', scope: 'company', companyId: 'company-a', nonce: 'n', exp: Math.floor(Date.now() / 1000) + 600 }): string {
  const p = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(p).digest('hex');
  return Buffer.from(JSON.stringify({ payload: p, signature })).toString('base64');
}

describe('#112 vault OAuth state secret fails closed', () => {
  let authorize: (req: NextRequest) => Promise<Response>;
  let callback: (req: NextRequest) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/board-route-auth' || id.endsWith('/lib/board-route-auth')) {
        return { requireBoardCompany: async () => ({ ok: true, value: { id: 'company-a' } }) };
      }
      if (id === '@/lib/vault-oauth-nonce-store' || id.endsWith('/lib/vault-oauth-nonce-store')) {
        return {
          recordOAuthNonce: async (n: string) => { nonces.add(n); },
          consumeOAuthNonce: async (n: string) => {
            if (!nonces.has(n)) return false;
            nonces.delete(n);
            return true;
          },
        };
      }
      if (id === '@tourbillon/db') {
        return {
          db: {
            query: {
              agents: { findFirst: async () => ({ id: 'agent-a1', status: 'active', companyId: 'company-a' }) },
              vaultSecrets: { findFirst: async () => null },
            },
            insert: () => ({ values: async () => [{}] }),
            update: () => ({ set: () => ({ where: async () => [{}] }) }),
          },
          agents: {},
          verification: {},
        };
      }
      if (id === '@tourbillon/db/schema') return { vaultSecrets: {} };
      if (id === '@tourbillon/shared/vault-encryption') return { encryptCredential: () => 'enc' };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: authorize } = await import('./authorize/route'));
    ({ GET: callback } = await import('./callback/route'));
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    nonces.clear();
    errors = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    delete env.GITHUB_OAUTH_CLIENT_SECRET;
    delete env.BETTER_AUTH_SECRET;
  });
  afterEach(() => {
    console.error = realConsoleError;
  });

  const start = () =>
    authorize(new NextRequest('http://localhost:3002/api/vault/oauth/authorize?serverId=github-mcp&scope=company'));
  const finish = (state: string, cookie?: string) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return callback(
      new NextRequest(`http://localhost:3002/api/vault/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
        headers,
      }),
    );
  };

  function assertRefusedAndLogged(res: Response, leaked: string[]) {
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), NOT_CONFIGURED);
    assert.equal(errors.length, 1, `exactly one server error (got ${JSON.stringify(errors)})`);
    assert.match(errors[0], /BETTER_AUTH_SECRET is unset or a known default/);
    assert.match(errors[0], /BETTER_AUTH_SECRET/);
    for (const s of leaked) assert.ok(!errors[0].includes(s), 'log never contains secret/state');
  }

  it('no secret: authorize is refused (no GitHub redirect) and logged', async () => {
    assertRefusedAndLogged(await start(), [REAL_SECRET]);
  });

  it('no secret: callback is refused before any state/company work and logged', async () => {
    assertRefusedAndLogged(await finish('anything'), ['anything']);
  });

  for (const def of DEFAULTS) {
    it(`default secret "${def.slice(0, 23)}…": authorize and callback are refused and logged`, async () => {
      env.BETTER_AUTH_SECRET = def;
      assertRefusedAndLogged(await start(), [def]);
      errors = [];
      const forged = stateSignedWithRaw(def);
      assertRefusedAndLogged(await finish(forged), [def, forged]);
    });
  }

  it('real secret: authorize → GitHub with bound state; callback with cookie reaches provider gate; raw-secret forge denied', async () => {
    env.BETTER_AUTH_SECRET = REAL_SECRET;
    const res = await start();
    assert.equal(res.status, 307);
    const location = new URL(res.headers.get('location') ?? '');
    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    const state = location.searchParams.get('state') ?? '';
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const nonceCookie = setCookie.find((c) => c.startsWith('tourbillon_vault_oauth_nonce.company-a='));
    assert.ok(nonceCookie, `company-scoped nonce cookie set (got ${JSON.stringify(setCookie)})`);
    const cookieHeader = nonceCookie!.split(';')[0];
    // Signature + cookie verify → consume → provider handling (no client secret → not_configured).
    const done = await finish(state, cookieHeader);
    assert.equal(done.headers.get('location'), '/settings?oauth_error=not_configured');
    // No Set-Cookie clear on callback.
    const cleared = (done.headers.getSetCookie?.() ?? []).some((c) => /Max-Age=0/i.test(c));
    assert.equal(cleared, false);
    // Forged with raw (non-derived) secret → invalid_state_signature.
    const forged = await finish(stateSignedWithRaw(REAL_SECRET), cookieHeader);
    assert.equal(forged.headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    const malformed = await finish(Buffer.from(JSON.stringify({ payload: 123 })).toString('base64'));
    assert.equal(malformed.headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    assert.deepEqual(errors, []);
  });
});
