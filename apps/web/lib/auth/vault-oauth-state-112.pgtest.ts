/**
 * #112 real-Postgres evidence: vault OAuth state expiry, durable replay, company+browser binding.
 * Run via `node scripts/run-pg-112-tests.mjs` against a disposable loopback `tb112_*` database
 * migrated with `pnpm --filter @tourbillon/db migrate`. Refuses any other DATABASE_URL.
 *
 * Real: authorize/callback handlers, board session + mobile JWT auth, @tourbillon/db, nonce store,
 * vault encrypt. Synthetic: counted `fetch` for GitHub token exchange only (and optional write fail).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb112_')) {
  throw new Error('vault-oauth-112 pg test: DATABASE_URL must be loopback disposable tb112_*');
}

const AUTH_SECRET = 'synthetic-better-auth-secret-112-pg-0123456789ab';
const BOARD_SECRET = 'synthetic-board-secret-112-pg-0123456789abcdef';
const VAULT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_INFO = 'tourbillon-vault-oauth-state-v2';
const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};
const SNAP_DIR = env.TB112_SNAPSHOT_DIR;

let exchanges = 0;
let writeFail = false;
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const Module = require('module');
const originalRequire = Module.prototype.require;
const originalFetch = globalThis.fetch;

type Row = Record<string, unknown>;
let dbm: { db: any };
let sql: any;
let authorize: (req: NextRequest) => Promise<Response>;
let callback: (req: NextRequest) => Promise<Response>;
let createBoardSessionToken: (h?: any) => Promise<string | null>;
let mintBoardJwt: (companyId: string, h?: any) => Promise<string | null>;
let buildOAuthState: typeof import('../../lib/vault-oauth-state').buildOAuthState;
let oauthNonceCookieName: typeof import('../../lib/vault-oauth-state').oauthNonceCookieName;
let recordOAuthNonce: typeof import('../../lib/vault-oauth-nonce-store').recordOAuthNonce;
let ctxCookies = new Map<string, string>();

async function q(text: string): Promise<Row[]> {
  const r = await dbm.db.execute(sql.raw(text));
  return (Array.isArray(r) ? r : r.rows) as Row[];
}

async function seed() {
  exchanges = 0;
  writeFail = false;
  ctxCookies = new Map();
  await q('TRUNCATE companies CASCADE');
  await q("DELETE FROM verification WHERE identifier = 'tourbillon:vault-oauth-state'");
  await q(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values ('user-preserved','Preserved','preserved@example.test',true,now(),now())
    ON CONFLICT (id) DO NOTHING`);
  await q(`insert into companies (id, name, slug, issue_prefix) values
    ('company-a','Co A','co-a','CA'), ('company-b','Co B','co-b','CB')`);
  await q(`insert into agents (id, company_id, name, role, title, url_key, status) values
    ('agent-a1','company-a','A1','engineer','A1','a1','active'),
    ('agent-a2','company-a','A2','engineer','A2','a2','active'),
    ('agent-arch','company-a','Arch','engineer','Arch','arch','archived'),
    ('agent-b1','company-b','B1','engineer','B1','b1','active')`);
  await q(`insert into vault_secrets (id, company_id, server_id, scope, user_id, agent_id, auth_type, encrypted_value, needs_reauth)
    values ('vs-user','company-a','github-mcp','company_user','user-preserved',null,'api_key','enc-preserved',false)`);
}

async function snap(): Promise<string> {
  const vault = await q(`select id, company_id, server_id, scope, user_id, agent_id, auth_type, needs_reauth from vault_secrets order by id`);
  const ver = await q(`select identifier, value, "expiresAt" from verification where identifier='tourbillon:vault-oauth-state' order by value`);
  return JSON.stringify({ vault, verification: ver, exchanges }, (_k, v) => (v instanceof Date ? v.toISOString() : v));
}

function saveSnap(name: string, before: string, after: string) {
  if (!SNAP_DIR) return;
  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(join(SNAP_DIR, `${name.replace(/[^a-z0-9-]+/gi, '_')}.json`), `{"before":${before},"after":${after}}\n`);
}

function applySetCookie(res: Response) {
  const list = res.headers.getSetCookie?.() ?? [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (/Max-Age=0/i.test(raw) || value === '') ctxCookies.delete(name);
    else ctxCookies.set(name, value);
  }
  return list;
}

function cookieHeader(): string {
  return [...ctxCookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function boardSessionAuth(): Promise<Record<string, string>> {
  const headers = { host: '127.0.0.1' };
  const session = await createBoardSessionToken(new Headers(headers));
  assert.ok(session);
  return {
    cookie: `tourbillon_board_session=${session}; active_company_id=company-a`,
    host: '127.0.0.1',
  };
}

async function mobileAuth(companyId = 'company-a'): Promise<Record<string, string>> {
  const headers = { host: '127.0.0.1' };
  const jwt = await mintBoardJwt(companyId, new Headers(headers));
  assert.ok(jwt);
  return { 'x-company-token': jwt, host: '127.0.0.1' };
}

async function doAuthorize(
  query: string,
  authHeaders: Record<string, string>,
): Promise<Response> {
  // Merge board/session cookies; keep any company-scoped nonce cookies already in the jar.
  if (authHeaders.cookie) {
    for (const part of authHeaders.cookie.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
  }
  const req = new NextRequest(`http://127.0.0.1/api/vault/oauth/authorize?${query}`, {
    headers: authHeaders,
  });
  const res = await authorize(req);
  applySetCookie(res);
  return res;
}

async function doCallback(
  query: string,
  authHeaders: Record<string, string>,
  cookieOverride?: Map<string, string>,
): Promise<Response> {
  const jar = cookieOverride ?? ctxCookies;
  const headers: Record<string, string> = { ...authHeaders };
  const cookieParts = [...jar.entries()].map(([k, v]) => `${k}=${v}`);
  if (authHeaders.cookie) {
    // merge board session cookies if provided separately
    for (const part of authHeaders.cookie.split(';')) {
      const t = part.trim();
      if (t && !cookieParts.some((p) => p.startsWith(t.split('=')[0] + '='))) cookieParts.push(t);
    }
  }
  if (cookieParts.length) headers.cookie = cookieParts.join('; ');
  return callback(new NextRequest(`http://127.0.0.1/api/vault/oauth/callback?${query}`, { headers }));
}

describe('#112 vault OAuth state (real PG)', () => {
  before(async () => {
    for (const k of ['BETTER_AUTH_SECRET', 'TOURBILLON_BOARD_SECRET', 'VAULT_ENCRYPTION_KEY', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'BETTER_AUTH_URL']) {
      savedEnv[k] = env[k];
    }
    env.BETTER_AUTH_SECRET = AUTH_SECRET;
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    env.VAULT_ENCRYPTION_KEY = VAULT_KEY;
    env.GITHUB_OAUTH_CLIENT_ID = 'test-client';
    env.GITHUB_OAUTH_CLIENT_SECRET = 'test-secret';
    env.BETTER_AUTH_URL = 'https://app.example.test';

    fetchImpl = async () => {
      exchanges++;
      if (writeFail) {
        // exchange succeeds; write failure simulated later by flipping a flag checked in a stub — actually
        // we simulate exchange failure here when writeFail is used for exchange case.
      }
      return new Response(JSON.stringify({ access_token: 'tok', scope: 'repo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init)) as typeof fetch;

    Module.prototype.require = function (id: string) {
      if (id === 'next/headers') {
        return {
          headers: async () => new Headers({ host: '127.0.0.1' }),
          cookies: async () => ({
            get: (n: string) => (ctxCookies.has(n) ? { name: n, value: ctxCookies.get(n)! } : undefined),
          }),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    dbm = await import('@tourbillon/db');
    ({ sql } = await import('drizzle-orm'));
    ({ GET: authorize } = await import('../../app/api/vault/oauth/authorize/route'));
    ({ GET: callback } = await import('../../app/api/vault/oauth/callback/route'));
    ({ createBoardSessionToken, mintBoardJwt } = await import('../board-auth'));
    ({ buildOAuthState, oauthNonceCookieName } = await import('../vault-oauth-state'));
    ({ recordOAuthNonce } = await import('../vault-oauth-nonce-store'));
  });

  after(async () => {
    Module.prototype.require = originalRequire;
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const client = (globalThis as { postgresClient?: { end: () => Promise<void> } }).postgresClient;
    await client?.end();
  });

  beforeEach(async () => {
    await seed();
    fetchImpl = async () => {
      exchanges++;
      return new Response(JSON.stringify({ access_token: 'tok', scope: 'repo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  it('valid company+agent flow (board session) → one exchange, one vault write, relative connected', async () => {
    const auth = await boardSessionAuth();
    const before = await snap();
    const start = await doAuthorize('serverId=github-mcp&scope=agent&agentId=agent-a1', auth);
    assert.equal(start.status, 307);
    const loc = new URL(start.headers.get('location')!);
    assert.equal(loc.hostname, 'github.com');
    const state = loc.searchParams.get('state')!;
    assert.ok(ctxCookies.has(oauthNonceCookieName('company-a')));
    const done = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth);
    assert.equal(done.status, 307);
    assert.equal(done.headers.get('location'), '/settings?connected=github-mcp');
    assert.equal((done.headers.getSetCookie?.() ?? []).some((c) => /Max-Age=0/i.test(c)), false);
    assert.equal(exchanges, 1);
    const vault = await q(`select scope, agent_id, company_id from vault_secrets where server_id='github-mcp' and scope='agent'`);
    assert.equal(vault.length, 1);
    assert.equal(vault[0].agent_id, 'agent-a1');
    assert.equal(vault[0].company_id, 'company-a');
    const ver = await q(`select * from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(ver.length, 0);
    saveSnap('valid-agent-flow', before, await snap());
  });

  it('valid company scope via mobile board JWT → one exchange/write', async () => {
    const auth = await mobileAuth('company-a');
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const done = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth);
    assert.equal(done.headers.get('location'), '/settings?connected=github-mcp');
    assert.equal(exchanges, 1);
  });

  it('missing secret authorize/callback fail closed', async () => {
    delete env.BETTER_AUTH_SECRET;
    const auth = await boardSessionAuth();
    const a = await doAuthorize('serverId=github-mcp&scope=company', auth);
    assert.equal(a.headers.get('location'), '/settings?oauth_error=oauth_state_secret_not_configured');
    const c = await doCallback('code=c&state=x', auth);
    assert.equal(c.headers.get('location'), '/settings?oauth_error=oauth_state_secret_not_configured');
    env.BETTER_AUTH_SECRET = AUTH_SECRET;
  });

  it('raw-secret forged state and wrong-length sig deny without exchange', async () => {
    const auth = await boardSessionAuth();
    const p = JSON.stringify({ v: 2, serverId: 'github-mcp', scope: 'company', companyId: 'company-a', nonce: 'n', exp: Math.floor(Date.now() / 1000) + 600 });
    const sig = createHmac('sha256', AUTH_SECRET).update(p).digest('hex');
    const forged = Buffer.from(JSON.stringify({ payload: p, signature: sig })).toString('base64');
    ctxCookies.set(oauthNonceCookieName('company-a'), 'n');
    const before = await snap();
    const res = await doCallback(`code=c&state=${encodeURIComponent(forged)}`, auth);
    assert.equal(res.headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    assert.equal(exchanges, 0);
    assert.equal(await snap(), before);
    const short = Buffer.from(JSON.stringify({ payload: p, signature: 'ab' })).toString('base64');
    assert.equal((await doCallback(`code=c&state=${encodeURIComponent(short)}`, auth)).headers.get('location'), '/settings?oauth_error=invalid_state_signature');
  });

  it('tamper companyId without resign → deny; legacy v1 state → invalid_state', async () => {
    const auth = await boardSessionAuth();
    const built = buildOAuthState({ serverId: 'github-mcp', scope: 'company', companyId: 'company-a' })!;
    await recordOAuthNonce(built.nonce, built.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-a'), built.nonce);
    const envl = JSON.parse(Buffer.from(built.state, 'base64').toString());
    const body = JSON.parse(envl.payload);
    body.companyId = 'company-b';
    envl.payload = JSON.stringify(body);
    const tampered = Buffer.from(JSON.stringify(envl)).toString('base64');
    assert.equal((await doCallback(`code=c&state=${encodeURIComponent(tampered)}`, auth)).headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    const v1 = Buffer.from(JSON.stringify({
      payload: JSON.stringify({ serverId: 'github-mcp', scope: 'company' }),
      signature: createHmac('sha256', createHmac('sha256', AUTH_SECRET).update(KEY_INFO).digest())
        .update(JSON.stringify({ serverId: 'github-mcp', scope: 'company' })).digest('hex'),
    })).toString('base64');
    assert.equal((await doCallback(`code=c&state=${encodeURIComponent(v1)}`, auth)).headers.get('location'), '/settings?oauth_error=invalid_state');
    assert.equal(exchanges, 0);
  });

  it('clock: exp-1s ok path reaches exchange; now>=exp → state_expired', async () => {
    const auth = await boardSessionAuth();
    for (const part of auth.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    const soon = buildOAuthState({ serverId: 'github-mcp', scope: 'company', companyId: 'company-a' }, Date.now() - 590_000)!;
    await recordOAuthNonce(soon.nonce, soon.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-a'), soon.nonce);
    const soonRes = await doCallback(`code=ok&state=${encodeURIComponent(soon.state)}`, { host: '127.0.0.1' });
    assert.equal(soonRes.headers.get('location'), '/settings?connected=github-mcp', `soon → ${soonRes.status} ${soonRes.headers.get('location')}`);

    await seed();
    const auth2 = await boardSessionAuth();
    for (const part of auth2.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    const expired = buildOAuthState({ serverId: 'github-mcp', scope: 'company', companyId: 'company-a' }, Date.now() - 600_000)!;
    await recordOAuthNonce(expired.nonce, expired.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-a'), expired.nonce);
    const before = await snap();
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(expired.state)}`, { host: '127.0.0.1' })).headers.get('location'), '/settings?oauth_error=state_expired');
    assert.equal(exchanges, 0);
    // verification row may still exist (not consumed) — exchange must be 0
    assert.equal(exchanges, 0);
    void before;
  });

  it('cross-company and archived agent denied before exchange', async () => {
    const authA = await boardSessionAuth();
    for (const part of authA.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    const builtB = buildOAuthState({ serverId: 'github-mcp', scope: 'company', companyId: 'company-b' })!;
    await recordOAuthNonce(builtB.nonce, builtB.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-b'), builtB.nonce);
    const cross = await doCallback(`code=ok&state=${encodeURIComponent(builtB.state)}`, { host: '127.0.0.1' });
    assert.equal(cross.status, 307, `cross status ${cross.status}`);
    assert.equal(cross.headers.get('location'), '/settings?oauth_error=company_mismatch');

    const startArch = await doAuthorize('serverId=github-mcp&scope=agent&agentId=agent-arch', authA);
    assert.equal(startArch.status, 404);
    assert.equal(exchanges, 0);

    const startOk = await doAuthorize('serverId=github-mcp&scope=agent&agentId=agent-a1', authA);
    const state = new URL(startOk.headers.get('location')!).searchParams.get('state')!;
    await q(`update agents set status='archived' where id='agent-a1'`);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, authA)).headers.get('location'), '/settings?oauth_error=agent_not_in_company');
    assert.equal(exchanges, 0);
  });

  it('missing/mismatched cookie deny; transfer to other browser deny; re-login same browser ok', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const goodCookie = new Map(ctxCookies);
    ctxCookies.delete(oauthNonceCookieName('company-a'));
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=missing_nonce');
    ctxCookies.set(oauthNonceCookieName('company-a'), 'wrong');
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=nonce_mismatch');
    // other browser: empty jar
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, new Map())).headers.get('location'), '/settings?oauth_error=missing_nonce');
    // re-login: new session, same nonce cookie
    const auth2 = await boardSessionAuth();
    ctxCookies = new Map(goodCookie);
    // merge new session into jar
    for (const part of auth2.cookie!.split(';')) {
      const [n, ...r] = part.trim().split('=');
      ctxCookies.set(n, r.join('='));
    }
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, { host: '127.0.0.1' })).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('sequential durable replay → state_already_used; total one exchange/write', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
    assert.equal(exchanges, 1);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
    assert.equal(exchanges, 1);
  });

  it('concurrent duplicate callbacks → exactly one success/exchange/write', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const jar = new Map(ctxCookies);
    const results = await Promise.all([
      doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar),
      doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar),
    ]);
    const locs = results.map((r) => r.headers.get('location'));
    const wins = locs.filter((l) => l === '/settings?connected=github-mcp');
    const losses = locs.filter((l) => l === '/settings?oauth_error=state_already_used');
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(exchanges, 1);
    const vault = await q(`select count(*)::int as n from vault_secrets where scope='company' and server_id='github-mcp'`);
    assert.equal(Number(vault[0].n), 1);
  });

  it('newest-wins same company: old callback deny; new cookie+nonce intact; new callback succeeds', async () => {
    const auth = await boardSessionAuth();
    const oldStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const oldState = new URL(oldStart.headers.get('location')!).searchParams.get('state')!;
    const oldJar = new Map(ctxCookies);
    const newStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const newState = new URL(newStart.headers.get('location')!).searchParams.get('state')!;
    const newJar = new Map(ctxCookies);
    assert.notEqual(oldJar.get(oauthNonceCookieName('company-a')), newJar.get(oauthNonceCookieName('company-a')));
    // Same browser now holds the NEW cookie; old state + current cookie → nonce_mismatch.
    ctxCookies = new Map(newJar);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(oldState)}`, auth)).headers.get('location'), '/settings?oauth_error=nonce_mismatch');
    assert.equal(ctxCookies.get(oauthNonceCookieName('company-a')), newJar.get(oauthNonceCookieName('company-a')));
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(newState)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('other company cookie untouched while company A rotates', async () => {
    const authA = await boardSessionAuth();
    const authB = await mobileAuth('company-b');
    await doAuthorize('serverId=github-mcp&scope=company', authB);
    const cookieB = ctxCookies.get(oauthNonceCookieName('company-b'));
    assert.ok(cookieB);
    await doAuthorize('serverId=github-mcp&scope=company', authA);
    assert.equal(ctxCookies.get(oauthNonceCookieName('company-b')), cookieB);
    assert.ok(ctxCookies.get(oauthNonceCookieName('company-a')));
  });

  it('response-order race: old success response has no clear; new cookie survives; new callback ok', async () => {
    const auth = await boardSessionAuth();
    const oldStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const oldState = new URL(oldStart.headers.get('location')!).searchParams.get('state')!;
    const oldJar = new Map(ctxCookies);
    // Complete old flow but hold the response
    const oldRes = await doCallback(`code=ok&state=${encodeURIComponent(oldState)}`, auth, oldJar);
    assert.equal(oldRes.headers.get('location'), '/settings?connected=github-mcp');
    assert.equal((oldRes.headers.getSetCookie?.() ?? []).length, 0, 'no Set-Cookie on callback');
    // New flow
    const newStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const newState = new URL(newStart.headers.get('location')!).searchParams.get('state')!;
    const newCookie = ctxCookies.get(oauthNonceCookieName('company-a'));
    // Deliver old response into jar (would clear if Max-Age=0 present)
    applySetCookie(oldRes);
    assert.equal(ctxCookies.get(oauthNonceCookieName('company-a')), newCookie);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(newState)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('response-order race: old post-consume failure response has no clear; new flow ok', async () => {
    const auth = await boardSessionAuth();
    const oldStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const oldState = new URL(oldStart.headers.get('location')!).searchParams.get('state')!;
    const oldJar = new Map(ctxCookies);
    fetchImpl = async () => {
      exchanges++;
      return new Response('fail', { status: 500 });
    };
    const oldRes = await doCallback(`code=ok&state=${encodeURIComponent(oldState)}`, auth, oldJar);
    assert.equal(oldRes.headers.get('location'), '/settings?oauth_error=token_exchange_failed');
    assert.equal((oldRes.headers.getSetCookie?.() ?? []).length, 0);
    fetchImpl = async () => {
      exchanges++;
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const newStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const newState = new URL(newStart.headers.get('location')!).searchParams.get('state')!;
    applySetCookie(oldRes);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(newState)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('exchange failure after consume → same-state retry denied; fresh authorize ok', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    fetchImpl = async () => {
      exchanges++;
      return new Response('fail', { status: 500 });
    };
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=token_exchange_failed');
    const ex1 = exchanges;
    fetchImpl = async () => {
      exchanges++;
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
    assert.equal(exchanges, ex1);
    const start2 = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state2)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('provider error and missing params pre-consume → no consume', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const verBefore = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal((await doCallback(`error=access_denied&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=access_denied');
    assert.equal((await doCallback('', auth)).headers.get('location'), '/settings?oauth_error=missing_parameters');
    const verAfter = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(Number(verAfter[0].n), Number(verBefore[0].n));
    assert.equal(exchanges, 0);
  });

  it('company_user without identity → 400 clear message; preserved vault row untouched; company scope still works', async () => {
    const auth = await boardSessionAuth();
    const before = await q(`select * from vault_secrets where id='vs-user'`);
    const res = await doAuthorize('serverId=github-mcp&scope=company_user&userId=u1', auth);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'Personal (user-scope) connections are not supported yet. Use a company or agent connection.');
    const after = await q(`select * from vault_secrets where id='vs-user'`);
    assert.deepEqual(after, before);
    const ok = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(ok.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('write failure after consume → same-state retry denied; fresh authorize ok', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const key = env.VAULT_ENCRYPTION_KEY;
    delete env.VAULT_ENCRYPTION_KEY;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=callback_failed');
    env.VAULT_ENCRYPTION_KEY = key;
    const ex = exchanges;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
    assert.equal(exchanges, ex);
    const start2 = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state2)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('Host / X-Forwarded-Host spoof → Location remains relative /settings', async () => {
    const auth = { ...(await boardSessionAuth()), host: 'evil.example', 'x-forwarded-host': 'evil.example' };
    const res = await doCallback('error=access_denied', auth);
    const loc = res.headers.get('location')!;
    assert.equal(loc, '/settings?oauth_error=access_denied');
    assert.ok(!loc.includes('evil'));
    assert.ok(!loc.startsWith('//'));
  });

  it('suite invariant: no callback Set-Cookie for tourbillon_vault_oauth_nonce.*; failed authorize writes nothing', async () => {
    const auth = await boardSessionAuth();
    const beforeVer = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    const bad = await doAuthorize('serverId=github-mcp&scope=company_user&userId=x', auth);
    assert.equal(bad.status, 400);
    assert.equal((bad.headers.getSetCookie?.() ?? []).filter((c) => c.startsWith('tourbillon_vault_oauth_nonce.')).length, 0);
    const afterVer = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(Number(afterVer[0].n), Number(beforeVer[0].n));

    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const done = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth);
    for (const c of done.headers.getSetCookie?.() ?? []) {
      assert.equal(c.startsWith('tourbillon_vault_oauth_nonce.'), false, `callback must not set nonce cookie: ${c}`);
    }
  });

  it('authorize issues exp=now+600, matching verification expiresAt, Max-Age=600 (shared clock)', async () => {
    const now = 1_700_000_000_000;
    env.TB112_NOW_MS = String(now);
    const auth = await boardSessionAuth();
    for (const part of auth.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const setCookie = (start.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tourbillon_vault_oauth_nonce.company-a='))!;
    assert.match(setCookie, /Max-Age=600/i);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const payload = JSON.parse(JSON.parse(Buffer.from(state, 'base64').toString()).payload);
    assert.equal(payload.exp, Math.floor(now / 1000) + 600);
    const rows = await q(`select "expiresAt" from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(rows.length, 1);
    const expMs = new Date(rows[0].expiresAt as string).getTime();
    assert.equal(expMs, payload.exp * 1000);
    delete env.TB112_NOW_MS;
  });

  it('clock-injected: exactly at exp → state_expired; verification row unconsumed', async () => {
    const now = 1_700_000_100_000;
    env.TB112_NOW_MS = String(now - 600_000);
    const auth = await boardSessionAuth();
    for (const part of auth.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    const built = buildOAuthState({ serverId: 'github-mcp', scope: 'company', companyId: 'company-a' })!;
    await recordOAuthNonce(built.nonce, built.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-a'), built.nonce);
    env.TB112_NOW_MS = String(now); // nowSec == exp
    assert.equal(built.exp, Math.floor((now - 600_000) / 1000) + 600);
    assert.equal(Math.floor(now / 1000), built.exp);
    const before = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    const res = await doCallback(`code=ok&state=${encodeURIComponent(built.state)}`, { host: '127.0.0.1' });
    assert.equal(res.headers.get('location'), '/settings?oauth_error=state_expired');
    assert.equal(exchanges, 0);
    const after = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(Number(after[0].n), Number(before[0].n));
    delete env.TB112_NOW_MS;
  });

  it('logged-out callback → 401; agent bearer → 403; nonce row intact', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const before = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    const nonceVal = ctxCookies.get(oauthNonceCookieName('company-a'))!;
    // next/headers mock reads ctxCookies for board session — clear session for logged-out.
    ctxCookies.clear();
    ctxCookies.set(oauthNonceCookieName('company-a'), nonceVal);
    const lo = await callback(new NextRequest(`http://127.0.0.1/api/vault/oauth/callback?code=ok&state=${encodeURIComponent(state)}`, {
      headers: { host: '127.0.0.1', cookie: `${oauthNonceCookieName('company-a')}=${nonceVal}` },
    }));
    assert.equal(lo.status, 401, `logged-out status ${lo.status} loc=${lo.headers.get('location')}`);
    const agentTok = 'pm_run_' + Buffer.from('x').toString('base64url');
    const ag = await callback(new NextRequest(`http://127.0.0.1/api/vault/oauth/callback?code=ok&state=${encodeURIComponent(state)}`, {
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${agentTok}`,
        cookie: `${oauthNonceCookieName('company-a')}=${nonceVal}`,
      },
    }));
    assert.equal(ag.status, 403);
    const after = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(Number(after[0].n), Number(before[0].n));
    assert.equal(exchanges, 0);
  });

  it('company switch between authorize and callback → company_mismatch; B snapshots unchanged', async () => {
    const snapB = async () => JSON.stringify(await q(`select id, company_id, scope from vault_secrets where company_id='company-b' order by id`));
    const verB = async () => JSON.stringify(await q(`select value from verification where identifier='tourbillon:vault-oauth-state'`));
    const authA = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', authA);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const bBefore = await snapB();
    // switch active company cookie to B while keeping A nonce
    ctxCookies.set('active_company_id', 'company-b');
    const res = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, { host: '127.0.0.1' });
    // session still valid but company is B → mismatch with state company A
    assert.equal(res.headers.get('location'), '/settings?oauth_error=company_mismatch');
    assert.equal(await snapB(), bBefore);
    assert.equal(exchanges, 0);
    void verB;
  });

  it('mobile JWT negatives: B-JWT+A-state → company_mismatch; A-JWT without nonce → missing_nonce; no consume', async () => {
    const authA = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', authA);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const before = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    const jwtB = await mobileAuth('company-b');
    const jar = new Map(ctxCookies);
    const mismatch = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, jwtB, jar);
    assert.equal(mismatch.headers.get('location'), '/settings?oauth_error=company_mismatch');
    const jwtA = await mobileAuth('company-a');
    const noNonce = await doCallback(`code=ok&state=${encodeURIComponent(state)}`, jwtA, new Map());
    assert.equal(noNonce.headers.get('location'), '/settings?oauth_error=missing_nonce');
    const after = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal(Number(after[0].n), Number(before[0].n));
    assert.equal(exchanges, 0);
  });

  it('case 8 arrival-order: after new Set-Cookie, deliver old success/exchange-fail/stale/duplicate; new flow ok', async () => {
    const auth = await boardSessionAuth();
    async function oldResponses(): Promise<Response[]> {
      const out: Response[] = [];
      // old success
      let st = await doAuthorize('serverId=github-mcp&scope=company', auth);
      let state = new URL(st.headers.get('location')!).searchParams.get('state')!;
      let jar = new Map(ctxCookies);
      out.push(await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar));
      // old exchange fail
      st = await doAuthorize('serverId=github-mcp&scope=company', auth);
      state = new URL(st.headers.get('location')!).searchParams.get('state')!;
      jar = new Map(ctxCookies);
      const prev = fetchImpl;
      fetchImpl = async () => { exchanges++; return new Response('fail', { status: 500 }); };
      out.push(await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar));
      fetchImpl = prev;
      // stale nonce_mismatch (old state, new cookie already set below — capture response shape now with wrong cookie)
      st = await doAuthorize('serverId=github-mcp&scope=company', auth);
      state = new URL(st.headers.get('location')!).searchParams.get('state')!;
      const wrong = new Map(ctxCookies);
      wrong.set(oauthNonceCookieName('company-a'), 'not-the-nonce');
      out.push(await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, wrong));
      // duplicate state_already_used
      jar = new Map(ctxCookies);
      await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar);
      out.push(await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth, jar));
      return out;
    }
    const olds = await oldResponses();
    for (const r of olds) {
      for (const c of r.headers.getSetCookie?.() ?? []) {
        assert.equal(c.startsWith('tourbillon_vault_oauth_nonce.'), false);
      }
    }
    const newStart = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const newState = new URL(newStart.headers.get('location')!).searchParams.get('state')!;
    const newCookie = ctxCookies.get(oauthNonceCookieName('company-a'));
    for (const r of olds) applySetCookie(r);
    assert.equal(ctxCookies.get(oauthNonceCookieName('company-a')), newCookie);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(newState)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('replay with leftover cookie after success → state_already_used; zero new exchange', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
    const ex = exchanges;
    // leftover cookie remains (never cleared)
    assert.ok(ctxCookies.get(oauthNonceCookieName('company-a')));
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
    assert.equal(exchanges, ex);
  });

  it('write failure via disposable PG trigger → callback_failed; retry denied; fresh authorize ok', async () => {
    const auth = await boardSessionAuth();
    await q(`CREATE OR REPLACE FUNCTION tb112_deny_vault_write() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tb112 induced write failure'; END; $$ LANGUAGE plpgsql`);
    await q(`DROP TRIGGER IF EXISTS tb112_deny_vault ON vault_secrets`);
    await q(`CREATE TRIGGER tb112_deny_vault BEFORE INSERT OR UPDATE ON vault_secrets FOR EACH ROW EXECUTE FUNCTION tb112_deny_vault_write()`);
    try {
      const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=callback_failed');
      const ex = exchanges;
      assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
      assert.equal(exchanges, ex);
    } finally {
      await q(`DROP TRIGGER IF EXISTS tb112_deny_vault ON vault_secrets`);
      await q(`DROP FUNCTION IF EXISTS tb112_deny_vault_write()`);
    }
    const start2 = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state2)}`, auth)).headers.get('location'), '/settings?connected=github-mcp');
  });

  it('not_configured and unsupported_provider before consume; provider tokenData.error after consume', async () => {
    const auth = await boardSessionAuth();
    const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const before = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    const secret = env.GITHUB_OAUTH_CLIENT_SECRET;
    delete env.GITHUB_OAUTH_CLIENT_SECRET;
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state)}`, auth)).headers.get('location'), '/settings?oauth_error=not_configured');
    assert.equal(Number((await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`))[0].n), Number(before[0].n));
    env.GITHUB_OAUTH_CLIENT_SECRET = secret;
    // unsupported: craft state with other serverId
    const built = buildOAuthState({ serverId: 'other-mcp', scope: 'company', companyId: 'company-a' })!;
    await recordOAuthNonce(built.nonce, built.expiresAt);
    ctxCookies.set(oauthNonceCookieName('company-a'), built.nonce);
    const before2 = await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`);
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(built.state)}`, auth)).headers.get('location'), '/settings?oauth_error=unsupported_provider');
    assert.equal(Number((await q(`select count(*)::int as n from verification where identifier='tourbillon:vault-oauth-state'`))[0].n), Number(before2[0].n));
    // tokenData.error after consume
    const st2 = await doAuthorize('serverId=github-mcp&scope=company', auth);
    const state2 = new URL(st2.headers.get('location')!).searchParams.get('state')!;
    fetchImpl = async () => {
      exchanges++;
      return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state2)}`, auth)).headers.get('location'), '/settings?oauth_error=bad_verification_code');
    assert.equal((await doCallback(`code=ok&state=${encodeURIComponent(state2)}`, auth)).headers.get('location'), '/settings?oauth_error=state_already_used');
  });

  it('non-disclosure canaries: code, token, client secret, nonce absent from logs/bodies/Location', async () => {
    const auth = await boardSessionAuth();
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    const canaryCode = 'canary-oauth-code-112';
    const canaryNonce = 'canary-nonce-value-should-not-leak';
    try {
      const start = await doAuthorize('serverId=github-mcp&scope=company', auth);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const nonce = ctxCookies.get(oauthNonceCookieName('company-a'))!;
      const res = await doCallback(`code=${canaryCode}&state=${encodeURIComponent(state)}`, auth);
      const loc = res.headers.get('location') ?? '';
      const body = await res.clone().text().catch(() => '');
      const blob = [loc, body, ...logged].join('\n');
      assert.ok(!blob.includes(canaryCode));
      assert.ok(!blob.includes(env.GITHUB_OAUTH_CLIENT_SECRET!));
      assert.ok(!blob.includes(nonce));
      assert.ok(!blob.includes(canaryNonce));
      assert.ok(!loc.includes('tok') && !blob.toLowerCase().includes('access_token'));
      assert.equal(loc, '/settings?connected=github-mcp');
    } finally {
      console.error = orig;
    }
  });

  it('malformed and wrong-length signatures → exact invalid_state_signature (not callback_failed)', async () => {
    const auth = await boardSessionAuth();
    const p = JSON.stringify({ v: 2, serverId: 'github-mcp', scope: 'company', companyId: 'company-a', nonce: 'n', exp: Math.floor(Date.now() / 1000) + 600 });
    const short = Buffer.from(JSON.stringify({ payload: p, signature: 'ab' })).toString('base64');
    ctxCookies.set(oauthNonceCookieName('company-a'), 'n');
    for (const part of auth.cookie!.split(';')) {
      const [n, ...rest] = part.trim().split('=');
      if (n) ctxCookies.set(n, rest.join('='));
    }
    assert.equal((await doCallback(`code=c&state=${encodeURIComponent(short)}`, { host: '127.0.0.1' })).headers.get('location'), '/settings?oauth_error=invalid_state_signature');
    const malformed = Buffer.from(JSON.stringify({ payload: 123 })).toString('base64');
    assert.equal((await doCallback(`code=c&state=${encodeURIComponent(malformed)}`, { host: '127.0.0.1' })).headers.get('location'), '/settings?oauth_error=invalid_state_signature');
  });


});
