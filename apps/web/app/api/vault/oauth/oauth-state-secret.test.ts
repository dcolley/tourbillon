/**
 * #112: the vault OAuth state HMAC fails closed. With BETTER_AUTH_SECRET unset or a known
 * public default, both starting (authorize) and finishing (callback) the flow are refused with
 * a relative /settings redirect + error flag, and one server error names the env var (never a
 * value). A real secret still completes the round trip.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const env = process.env as Record<string, string | undefined>;
const REAL_SECRET = 'real-better-auth-secret-for-oauth-tests-0123456789';
const DEFAULTS = ['change-me-in-production', 'change-me-in-production-use-openssl-rand-base64-32'];
const NOT_CONFIGURED = '/settings?oauth_error=oauth_state_secret_not_configured';

let companyLookups = 0;
const nonces = new Set<string>();
let errors: string[] = [];
const realConsoleError = console.error;

/** A state exactly as the authorize route builds it, signed with `secret`. */
function stateSignedWith(secret: string, payload = { serverId: 'unsupported-x', scope: 'company' }): string {
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
        return {
          requireBoardCompany: async () => {
            companyLookups++;
            return { ok: true, value: { id: 'company-a' } };
          },
        };
      }
      if (id === '@/lib/vault-oauth-nonce-store' || id.endsWith('/lib/vault-oauth-nonce-store')) {
        // #112 single-use store, in memory (the real one is covered by state-binding.test.ts).
        return {
          recordOAuthNonce: async (nonce: string) => void nonces.add(nonce),
          consumeOAuthNonce: async (nonce: string) => nonces.delete(nonce),
        };
      }
      if (id === '@tourbillon/db') return { db: { query: {} }, agents: {} };
      if (id === '@tourbillon/db/schema') return { vaultSecrets: {} };
      if (id === '@tourbillon/shared/vault-encryption') return { encryptCredential: () => 'enc' };
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompany: async () => {
            companyLookups++;
            return { id: 'company-a' };
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: authorize } = await import('./authorize/route'));
    ({ GET: callback } = await import('./callback/route'));
    Module.prototype.require = originalRequire;
  });

  beforeEach(() => {
    companyLookups = 0;
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
  const finish = (state: string, nonce?: string) =>
    callback(
      new NextRequest(`http://localhost:3002/api/vault/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
        headers: nonce ? { cookie: `tourbillon_vault_oauth_nonce=${nonce}` } : {},
      }),
    );

  function assertRefusedAndLogged(res: Response, stage: 'start' | 'finish', leaked: string[]) {
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), NOT_CONFIGURED);
    assert.equal(errors.length, 1, `exactly one server error (got ${JSON.stringify(errors)})`);
    assert.match(errors[0], /BETTER_AUTH_SECRET is unset or a known default/);
    assert.match(errors[0], new RegExp(`refusing to ${stage} the OAuth flow`));
    for (const v of leaked) assert.ok(!errors[0].includes(v), 'log must not contain a secret or state value');
  }

  it('no secret: authorize is refused (no GitHub redirect) and logged', async () => {
    assertRefusedAndLogged(await start(), 'start', []);
  });

  it('no secret: callback is refused before any state/company work and logged', async () => {
    const state = stateSignedWith('change-me-in-production');
    assertRefusedAndLogged(await finish(state), 'finish', [state]);
    assert.equal(companyLookups, 0);
  });

  for (const def of DEFAULTS) {
    it(`default secret "${def.slice(0, 23)}…": authorize and callback are refused and logged`, async () => {
      env.BETTER_AUTH_SECRET = def;
      assertRefusedAndLogged(await start(), 'start', [def]);
      errors = [];
      companyLookups = 0;
      const forged = stateSignedWith(def);
      assertRefusedAndLogged(await finish(forged), 'finish', [def, forged]);
      assert.equal(companyLookups, 0);
    });
  }

  it('real secret: authorize → GitHub with a state that the callback accepts; default-signed state is rejected', async () => {
    env.BETTER_AUTH_SECRET = REAL_SECRET;
    const res = await start();
    assert.equal(res.status, 307);
    const location = new URL(res.headers.get('location') ?? '');
    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    const state = location.searchParams.get('state') ?? '';
    // #112: authorize also sets the nonce cookie the callback needs.
    const nonce = /tourbillon_vault_oauth_nonce=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(nonce, 'authorize sets the nonce cookie');
    companyLookups = 0;
    // Signature verifies → reaches provider handling (no client secret here → not_configured).
    const done = await finish(state, nonce);
    assert.equal(done.headers.get('location'), '/settings?oauth_error=not_configured');
    assert.equal(companyLookups, 1);
    // A state forged with the public default is not accepted under a real secret.
    const forged = await finish(stateSignedWith('change-me-in-production'));
    assert.equal(forged.headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    // A malformed state (non-string payload, no signature) is a clean signature failure,
    // not a thrown HMAC error falling through to callback_failed.
    const malformed = await finish(Buffer.from(JSON.stringify({ payload: 123 })).toString('base64'));
    assert.equal(malformed.headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    assert.deepEqual(errors, []);
  });
});
