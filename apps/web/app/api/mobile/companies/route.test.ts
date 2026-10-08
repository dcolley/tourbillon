/**
 * #105: POST /api/mobile/companies requires the operator secret; GET requires board auth.
 * @/lib/company is mocked (no db); auth helpers are real.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, jwtVerify } from 'jose';
import { NextRequest } from 'next/server';

const BOARD_SECRET = 'test-operator-secret-105';
const JWT_SECRET = 'test-better-auth-secret-not-default';
const LOOPBACK = { host: 'localhost:3002' };
const AGENT_TOKEN = `pm_run_${Buffer.from(
  JSON.stringify({ runId: 'r1', agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;
const jwtKey = () =>
  new TextEncoder().encode(process.env.BETTER_AUTH_SECRET || 'change-me-in-production');

async function boardJwt(companyId: string, key = jwtKey()) {
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);
}

function post(headers: Record<string, string> = {}, body: unknown = { companyId: 'company-a' }) {
  return new NextRequest('http://localhost/api/mobile/companies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function get(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/mobile/companies', { headers });
}

const state = { cookieSet: [] as string[], boardSession: false };
const env = process.env as Record<string, string | undefined>;

describe('#105 /api/mobile/companies', () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let POST: (req: NextRequest) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const company = { id: 'company-a', name: 'A', issuePrefix: 'A', slug: 'a' };
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          listCompanies: async () => [company],
          getCompanyById: async (cid: string) => (cid === company.id ? company : null),
          setActiveCompanyCookie: async (cid: string) => {
            state.cookieSet.push(cid);
          },
          hasBoardSession: async () => state.boardSession,
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET, POST } = await import('./route'));
  });

  beforeEach(() => {
    state.cookieSet = [];
    state.boardSession = false;
    env.NODE_ENV = 'test';
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    env.BETTER_AUTH_SECRET = JWT_SECRET;
  });

  it('mint without operator secret → 401, no token, no cookie', async () => {
    const res = await POST(post());
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '');
    assert.deepEqual(state.cookieSet, []);
  });

  it('mint with wrong operator secret → 401', async () => {
    const res = await POST(post({ 'X-Board-Secret': 'wrong' }));
    assert.equal(res.status, 401);
  });

  it('env unset → mint fails closed even with a header', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    const res = await POST(post({ 'X-Board-Secret': 'anything' }));
    assert.equal(res.status, 401);
    assert.deepEqual(state.cookieSet, []);
  });

  it('env unset + TOURBILLON_BOARD_AUTH_INSECURE_DEV=1 (non-production, loopback host) → mint allowed', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    const res = await POST(post({ 'X-Board-Secret': 'dev', ...LOOPBACK }));
    assert.equal(res.status, 200);
  });

  it('insecure-dev flag is refused on a non-loopback host (B3)', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    env.NODE_ENV = 'development';
    assert.equal((await POST(post({ 'X-Board-Secret': 'dev', host: 'tourbillon-test.example.com' }))).status, 401);
    // Spoofed loopback Host behind a proxy that forwards the public host is still refused.
    assert.equal(
      (await POST(post({ 'X-Board-Secret': 'dev', ...LOOPBACK, 'x-forwarded-host': 'tourbillon-test.example.com' }))).status,
      401,
    );
    // No Host header at all → refused.
    assert.equal((await POST(post({ 'X-Board-Secret': 'dev' }))).status, 401);
  });

  it('NODE_ENV=development alone does not enable the insecure-dev opt-in (B3)', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    env.NODE_ENV = 'development';
    assert.equal((await POST(post({ 'X-Board-Secret': 'dev', ...LOOPBACK }))).status, 401);
  });

  for (const nodeEnv of ['development', 'test', 'production']) {
    it(`NODE_ENV=${nodeEnv}: unset/default BETTER_AUTH_SECRET refuses to mint (503) (B3)`, async () => {
      env.NODE_ENV = nodeEnv;
      delete env.BETTER_AUTH_SECRET;
      assert.equal((await POST(post({ 'X-Board-Secret': BOARD_SECRET, ...LOOPBACK }))).status, 503);
      env.BETTER_AUTH_SECRET = 'change-me-in-production';
      assert.equal((await POST(post({ 'X-Board-Secret': BOARD_SECRET, ...LOOPBACK }))).status, 503);
    });

    it(`NODE_ENV=${nodeEnv}: board JWT signed with the public default secret is rejected (B3)`, async () => {
      env.NODE_ENV = nodeEnv;
      env.BETTER_AUTH_SECRET = 'change-me-in-production';
      const forged = await boardJwt('company-a', new TextEncoder().encode('change-me-in-production'));
      assert.equal((await GET(get({ 'X-Company-Token': forged, ...LOOPBACK }))).status, 401);
      delete env.BETTER_AUTH_SECRET;
      assert.equal((await GET(get({ 'X-Company-Token': forged, ...LOOPBACK }))).status, 401);
    });
  }

  it('insecure-dev + loopback may use the default BETTER_AUTH_SECRET (local dev only)', async () => {
    env.NODE_ENV = 'development';
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    delete env.BETTER_AUTH_SECRET;
    const res = await POST(post({ 'X-Board-Secret': BOARD_SECRET, ...LOOPBACK }));
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    assert.equal((await GET(get({ 'X-Company-Token': token, ...LOOPBACK }))).status, 200);
    // The same token presented on a public host is rejected.
    assert.equal((await GET(get({ 'X-Company-Token': token, host: 'tourbillon-test.example.com' }))).status, 401);
  });

  it('insecure-dev flag is ignored in production', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    env.NODE_ENV = 'production';
    env.BETTER_AUTH_SECRET = 'a-real-prod-secret';
    const res = await POST(post({ 'X-Board-Secret': 'dev' }));
    assert.equal(res.status, 401);
  });

  it('mint with agent run token + valid secret → 401', async () => {
    const res = await POST(post({ 'X-Board-Secret': BOARD_SECRET, Authorization: `Bearer ${AGENT_TOKEN}` }));
    assert.equal(res.status, 401);
  });

  it('mint with valid operator secret → 200 + verifiable board JWT', async () => {
    const res = await POST(post({ 'X-Board-Secret': BOARD_SECRET }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; company: { id: string } };
    assert.equal(body.company.id, 'company-a');
    const { payload } = await jwtVerify(body.token, jwtKey());
    assert.equal(payload.companyId, 'company-a');
    assert.deepEqual(state.cookieSet, ['company-a']);
  });

  it('production with default BETTER_AUTH_SECRET refuses to mint (fail closed)', async () => {
    env.NODE_ENV = 'production';
    delete env.BETTER_AUTH_SECRET;
    const res = await POST(post({ 'X-Board-Secret': BOARD_SECRET }));
    assert.equal(res.status, 503);
  });

  it('unauthenticated list → 401 with empty body', async () => {
    const res = await GET(get());
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '');
  });

  it('list with forged board JWT → 401', async () => {
    const forged = await boardJwt('company-a', new TextEncoder().encode('attacker-key'));
    const res = await GET(get({ 'X-Company-Token': forged }));
    assert.equal(res.status, 401);
  });

  it('list with agent token + valid board JWT → 401', async () => {
    const res = await GET(
      get({ 'X-Company-Token': await boardJwt('company-a'), Authorization: `Bearer ${AGENT_TOKEN}` }),
    );
    assert.equal(res.status, 401);
  });

  it('list with valid board JWT → 200', async () => {
    const res = await GET(get({ 'X-Company-Token': await boardJwt('company-a') }));
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as Array<{ id: string }>).map((c) => c.id), ['company-a']);
  });

  it('list with operator secret (pairing) → 200; wrong secret → 401', async () => {
    assert.equal((await GET(get({ 'X-Board-Secret': BOARD_SECRET }))).status, 200);
    assert.equal((await GET(get({ 'X-Board-Secret': 'nope' }))).status, 401);
  });

  it('list with a board session cookie → 200', async () => {
    state.boardSession = true;
    assert.equal((await GET(get())).status, 200);
  });
});
