/**
 * #112 items 3–4: vault OAuth state is bound to the browser (httpOnly nonce cookie), the board
 * company and the agent, expires after 10 minutes and is single-use (nonce redeemed from the
 * `verification` table). Every negative case fails closed with NO token exchange and no vault
 * write. Routes + vault-oauth-state + vault-oauth-nonce-store are real; the db, drizzle operators
 * and the board guard are small in-memory fakes.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const env = process.env as Record<string, string | undefined>;
const SECRET = 'real-better-auth-secret-for-state-binding-0123456789';
const COOKIE = 'tourbillon_vault_oauth_nonce';

// ---- in-memory db + drizzle operators --------------------------------------------------------
type Row = Record<string, unknown>;
type Cond =
  | { op: 'eq' | 'gt' | 'lt'; c: string; val: unknown }
  | { op: 'and'; xs: Cond[] };
const store: Record<string, Row[]> = {};
const table = (name: string) =>
  new Proxy({} as Record<string, unknown>, { get: (_t, prop: string) => (prop === '__table' ? name : { c: prop }) });
const nameOf = (t: unknown) => (t as { __table: string }).__table;
const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
function match(row: Row, cond?: Cond): boolean {
  if (!cond) return true;
  if (cond.op === 'and') return cond.xs.every((x) => match(row, x));
  if (cond.op === 'eq') return row[cond.c] === cond.val;
  if (cond.op === 'gt') return num(row[cond.c]) > num(cond.val);
  return num(row[cond.c]) < num(cond.val);
}
const fakeDb = {
  query: new Proxy({}, {
    get: (_t, name: string) => ({
      findFirst: async ({ where }: { where?: Cond } = {}) => (store[name] ?? []).find((r) => match(r, where)),
    }),
  }),
  insert: (t: unknown) => ({
    values: async (v: Row) => {
      (store[nameOf(t)] ??= []).push({ ...v });
    },
  }),
  update: (t: unknown) => ({
    set: (v: Row) => ({
      where: async (cond: Cond) => (store[nameOf(t)] ?? []).filter((r) => match(r, cond)).forEach((r) => Object.assign(r, v)),
    }),
  }),
  // DELETE … WHERE … [RETURNING]: runs once, synchronously (like one atomic statement).
  delete: (t: unknown) => ({
    where: (cond: Cond) => {
      const name = nameOf(t);
      const hit = (store[name] ?? []).filter((r) => match(r, cond));
      store[name] = (store[name] ?? []).filter((r) => !match(r, cond));
      return { returning: async () => hit, then: (ok: (v: Row[]) => unknown) => Promise.resolve(hit).then(ok) };
    },
  }),
};

// ---- board guard + GitHub ----------------------------------------------------------------------
let boardCompanyId: string | null = 'company-a';
let fetchCalls = 0;
const realFetch = globalThis.fetch;

type Handler = (req: NextRequest) => Promise<Response>;
let authorize: Handler;
let callback: Handler;
let lib: typeof import('../../../../lib/vault-oauth-state');
let nonceStore: typeof import('../../../../lib/vault-oauth-nonce-store');

const authorizeReq = (query: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3002/api/vault/oauth/authorize?${query}`, { headers });
const callbackReq = (state: string, nonce?: string | null) =>
  new NextRequest(`http://localhost:3002/api/vault/oauth/callback?code=gh-code&state=${encodeURIComponent(state)}`, {
    headers: nonce ? { cookie: `${COOKIE}=${nonce}` } : {},
  });

function nonceCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
}

/** Start a flow as the board of `companyId`; returns the state and the nonce cookie value. */
async function start(query = 'serverId=github-mcp&scope=agent&agentId=agent-a', companyId = 'company-a') {
  const prev = boardCompanyId;
  boardCompanyId = companyId;
  try {
    const res = await authorize(authorizeReq(query));
    assert.equal(res.status, 307);
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const nonce = /^[^=]+=([^;]*)/.exec(nonceCookie(res) ?? '')?.[1] ?? '';
    assert.ok(state && nonce, 'authorize returns a state and sets the nonce cookie');
    return { res, state, nonce };
  } finally {
    boardCompanyId = prev;
  }
}

function payloadOf(state: string): Record<string, unknown> {
  return JSON.parse(JSON.parse(Buffer.from(state, 'base64').toString('utf8')).payload);
}

/** Every refusal: relative /settings error redirect, no GitHub call, no vault write. */
function assertRefused(res: Response, code: string) {
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `/settings?oauth_error=${code}`);
  assert.equal(fetchCalls, 0, 'no token exchange');
  assert.equal((store.vaultSecrets ?? []).length, 0, 'no vault write');
  assert.match(nonceCookie(res) ?? '', /Max-Age=0/, 'nonce cookie cleared');
}

describe('#112 vault OAuth state binding (nonce cookie + company + agent + exp, single use)', () => {
  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const is = (id: string, name: string) => id === `@/lib/${name}` || id.endsWith(`/lib/${name}`);
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') return { db: fakeDb, agents: table('agents'), verification: table('verification') };
      if (id === '@tourbillon/db/schema') return { vaultSecrets: table('vaultSecrets') };
      if (id === 'drizzle-orm') {
        return {
          eq: (col: { c: string }, val: unknown) => ({ op: 'eq', c: col.c, val }),
          gt: (col: { c: string }, val: unknown) => ({ op: 'gt', c: col.c, val }),
          lt: (col: { c: string }, val: unknown) => ({ op: 'lt', c: col.c, val }),
          and: (...xs: Cond[]) => ({ op: 'and', xs }),
        };
      }
      if (id === '@tourbillon/shared/vault-encryption') return { encryptCredential: () => 'enc' };
      if (is(id, 'board-route-auth')) {
        return {
          requireBoardCompany: async () =>
            boardCompanyId
              ? { ok: true, value: { id: boardCompanyId } }
              : { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET: authorize } = await import('./authorize/route'));
    ({ GET: callback } = await import('./callback/route'));
    lib = await import('../../../../lib/vault-oauth-state');
    nonceStore = await import('../../../../lib/vault-oauth-nonce-store');
    Module.prototype.require = originalRequire;

    globalThis.fetch = (async () => {
      fetchCalls++;
      return Response.json({ access_token: 'gho_test', scope: 'repo,user' });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    env.BETTER_AUTH_SECRET = SECRET;
    env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
    delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    boardCompanyId = 'company-a';
    fetchCalls = 0;
    store.agents = [
      { id: 'agent-a', companyId: 'company-a' },
      { id: 'agent-b', companyId: 'company-b' },
    ];
    store.verification = [];
    store.vaultSecrets = [];
  });

  it('authorize: nonce cookie is httpOnly, Secure, SameSite=Lax, callback path, 10 min; state carries nonce + companyId + agentId + exp', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { res, state, nonce } = await start();
    const cookie = nonceCookie(res) ?? '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /; Secure/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Path=\/api\/vault\/oauth\/callback/);
    assert.match(cookie, /Max-Age=600/);
    assert.ok(nonce.length >= 43, '32 random bytes, base64url');

    const p = payloadOf(state);
    assert.equal(p.v, 2);
    assert.equal(p.nonce, nonce);
    assert.equal(p.companyId, 'company-a');
    assert.equal(p.agentId, 'agent-a');
    assert.equal(p.scope, 'agent');
    assert.ok(!('userId' in p));
    assert.ok((p.exp as number) >= before + 600 && (p.exp as number) <= before + 601);

    // Server-side single-use record: only the hash, expiring with the state.
    assert.equal(store.verification.length, 1);
    const row = store.verification[0];
    assert.equal(row.identifier, nonceStore.OAUTH_NONCE_IDENTIFIER);
    assert.equal(row.value, createHash('sha256').update(nonce).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(nonce));
    assert.equal((row.expiresAt as Date).getTime(), (p.exp as number) * 1000);
  });

  it('authorize: Secure is dropped only under the loopback insecure-dev opt-in', async () => {
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    const res = await authorize(authorizeReq('serverId=github-mcp&scope=company', { host: 'localhost:3002' }));
    assert.doesNotMatch(nonceCookie(res) ?? '', /; Secure/i);
    const remote = await authorize(authorizeReq('serverId=github-mcp&scope=company', { host: 'tourbillon.example.test' }));
    assert.match(nonceCookie(remote) ?? '', /; Secure/i);
  });

  it('authorize: user-scoped grants and agentId/scope mismatches are refused (no cookie, no record)', async () => {
    for (const q of [
      'serverId=github-mcp&scope=company_user&userId=user-1',
      'serverId=github-mcp&scope=company&userId=user-1',
      'serverId=github-mcp&scope=agent',
      'serverId=github-mcp&scope=company&agentId=agent-a',
    ]) {
      const res = await authorize(authorizeReq(q));
      assert.equal(res.status, 400, q);
      assert.equal(nonceCookie(res), undefined, q);
    }
    assert.equal(store.verification.length, 0);
  });

  it('happy path: matching cookie, same company, own agent → one token exchange, vault row, cookie cleared, nonce consumed', async () => {
    const { state, nonce } = await start();
    const res = await callback(callbackReq(state, nonce));
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), '/settings?connected=github-mcp');
    assert.equal(fetchCalls, 1);
    assert.equal(store.vaultSecrets.length, 1);
    assert.equal(store.vaultSecrets[0].companyId, 'company-a');
    assert.equal(store.vaultSecrets[0].agentId, 'agent-a');
    assert.equal(store.vaultSecrets[0].scope, 'agent');
    const cleared = nonceCookie(res) ?? '';
    assert.match(cleared, new RegExp(`^${COOKIE}=;`));
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Path=\/api\/vault\/oauth\/callback/);
    assert.equal(store.verification.length, 0, 'nonce redeemed');
  });

  it('replayed state (same state + cookie again) → state_already_used, no second exchange', async () => {
    const { state, nonce } = await start();
    assert.equal((await callback(callbackReq(state, nonce))).headers.get('location'), '/settings?connected=github-mcp');
    fetchCalls = 0;
    store.vaultSecrets = [];
    assertRefused(await callback(callbackReq(state, nonce)), 'state_already_used');
  });

  it('two concurrent callbacks with the same state → exactly one succeeds', async () => {
    const { state, nonce } = await start();
    const results = await Promise.all([callback(callbackReq(state, nonce)), callback(callbackReq(state, nonce))]);
    const locations = results.map((r) => r.headers.get('location')).sort();
    assert.deepEqual(locations, ['/settings?connected=github-mcp', '/settings?oauth_error=state_already_used']);
    assert.equal(fetchCalls, 1);
  });

  it('expired state (> 10 min) → state_expired', async () => {
    const { state, nonce } = await start();
    const realNow = Date.now;
    Date.now = () => realNow() + (10 * 60 + 1) * 1000;
    try {
      assertRefused(await callback(callbackReq(state, nonce)), 'state_expired');
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.verification.length, 1, 'nonce not consumed by a refused callback');
  });

  it('cross-company: state issued for company B, finished under company A → company_mismatch', async () => {
    const { state, nonce } = await start('serverId=github-mcp&scope=agent&agentId=agent-b', 'company-b');
    assertRefused(await callback(callbackReq(state, nonce)), 'company_mismatch');
  });

  it("cross-company: validly signed state for company A naming company B's agent → agent_not_in_company", async () => {
    const built = lib.buildOAuthState({ serverId: 'github-mcp', scope: 'agent', agentId: 'agent-b', companyId: 'company-a' });
    assert.ok(built);
    await nonceStore.recordOAuthNonce(built.nonce, built.expiresAt);
    assertRefused(await callback(callbackReq(built.state, built.nonce)), 'agent_not_in_company');
  });

  it('missing nonce cookie → missing_nonce', async () => {
    const { state } = await start();
    assertRefused(await callback(callbackReq(state, null)), 'missing_nonce');
  });

  it('nonce mismatch (cookie from another flow / attacker) → nonce_mismatch', async () => {
    const { state } = await start();
    const other = await start();
    assertRefused(await callback(callbackReq(state, other.nonce)), 'nonce_mismatch');
    assertRefused(await callback(callbackReq(state, 'x'.repeat(43))), 'nonce_mismatch');
  });

  it('tampered state: edited payload or edited signature → invalid_state_signature', async () => {
    const { state, nonce } = await start();
    const envelope = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    const edited = { ...envelope, payload: envelope.payload.replace('"company-a"', '"company-b"') };
    assert.notEqual(edited.payload, envelope.payload);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    boardCompanyId = 'company-b';
    assertRefused(await callback(callbackReq(b64(edited), nonce)), 'invalid_state_signature');
    boardCompanyId = 'company-a';
    const flipped = envelope.signature.replace(/^./, (c: string) => (c === '0' ? '1' : '0'));
    assertRefused(await callback(callbackReq(b64({ ...envelope, signature: flipped }), nonce)), 'invalid_state_signature');
  });

  it('pre-#112 state (signed, but no nonce/companyId/exp) → invalid_state', async () => {
    const payload = JSON.stringify({ serverId: 'github-mcp', scope: 'company' });
    const signature = lib.signOAuthState(payload);
    const state = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
    assertRefused(await callback(callbackReq(state, 'anything')), 'invalid_state');
  });

  it('user-scoped state (signed) → user_scope_unsupported', async () => {
    const built = lib.buildOAuthState({ serverId: 'github-mcp', scope: 'company_user', companyId: 'company-a' });
    assert.ok(built);
    await nonceStore.recordOAuthNonce(built.nonce, built.expiresAt);
    assertRefused(await callback(callbackReq(built.state, built.nonce)), 'user_scope_unsupported');
  });

  it('no board session on the callback → 401, no exchange, cookie cleared', async () => {
    const { state, nonce } = await start();
    boardCompanyId = null;
    const res = await callback(callbackReq(state, nonce));
    assert.equal(res.status, 401);
    assert.equal(fetchCalls, 0);
    assert.match(nonceCookie(res) ?? '', /Max-Age=0/);
  });

  it('nonce store: a recorded nonce redeems once; unknown and expired nonces never do', async () => {
    await nonceStore.recordOAuthNonce('n-live', new Date(Date.now() + 60_000));
    await nonceStore.recordOAuthNonce('n-old', new Date(Date.now() - 1));
    assert.equal(await nonceStore.consumeOAuthNonce('n-live'), true);
    assert.equal(await nonceStore.consumeOAuthNonce('n-live'), false);
    assert.equal(await nonceStore.consumeOAuthNonce('n-unknown'), false);
    assert.equal(await nonceStore.consumeOAuthNonce('n-old'), false);
    // Recording sweeps this identifier's expired rows.
    await nonceStore.recordOAuthNonce('n-next', new Date(Date.now() + 60_000));
    assert.deepEqual(
      store.verification.map((r) => r.value),
      [createHash('sha256').update('n-next').digest('hex')],
    );
  });
});
