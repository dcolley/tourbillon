/** #105: proxy gates web UI pages and server actions on a valid board session cookie. */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const BOARD_SECRET = 'test-operator-secret-105';
const AGENT_TOKEN = `pm_run_${Buffer.from(
  JSON.stringify({ runId: 'r1', agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;
const env = process.env as Record<string, string | undefined>;

describe('#105 proxy board gate', () => {
  let proxy: typeof import('./proxy').proxy;
  let createBoardSessionToken: typeof import('./lib/board-auth').createBoardSessionToken;

  before(async () => {
    ({ proxy } = await import('./proxy'));
    ({ createBoardSessionToken } = await import('./lib/board-auth'));
  });
  beforeEach(() => {
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
  });

  const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`http://localhost${path}`, init);

  it('landing page, /unlock and /health are public for GET', async () => {
    assert.equal((await proxy(req('/'))).headers.get('x-middleware-next'), '1');
    assert.equal((await proxy(req('/health'))).headers.get('x-middleware-next'), '1');
    assert.equal((await proxy(req('/unlock'))).headers.get('x-middleware-next'), '1');
  });

  it('dashboard without session → redirect to /unlock?next=', async () => {
    const res = await proxy(req('/dashboard?x=1', { headers: { cookie: 'active_company_id=company-a' } }));
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), 'http://localhost/unlock?next=%2Fdashboard%3Fx%3D1');
  });

  it('server action POST without session → 401 (including to public paths)', async () => {
    const res = await proxy(req('/', { method: 'POST', headers: { 'next-action': 'abc' } }));
    assert.equal(res.status, 401);
    assert.equal((await proxy(req('/select-company', { method: 'POST' }))).status, 401);
  });

  it('forged session cookie → redirect', async () => {
    const res = await proxy(req('/bullmq', { headers: { cookie: 'tourbillon_board_session=forged.jwt.value' } }));
    assert.equal(res.status, 307);
  });

  it('valid session cookie → pass through', async () => {
    const token = await createBoardSessionToken();
    const res = await proxy(req('/dashboard', { headers: { cookie: `tourbillon_board_session=${token}` } }));
    assert.equal(res.headers.get('x-middleware-next'), '1');
  });

  it('matcher excludes /api, Next assets and static images; includes pages', async () => {
    const { config } = await import('./proxy');
    const { pathToRegexp } = require('next/dist/compiled/path-to-regexp') as {
      pathToRegexp: (p: string) => RegExp;
    };
    const re = pathToRegexp(config.matcher[0]);
    for (const p of ['/api/mobile/companies', '/api/auth/login', '/_next/static/x.js', '/logo.svg', '/favicon.ico']) {
      assert.equal(re.test(p), false, p);
    }
    for (const p of ['/dashboard', '/select-company', '/bullmq', '/agent/x', '/']) {
      assert.equal(re.test(p), true, p);
    }
  });

  it('agent run token + valid session cookie → not board', async () => {
    const token = await createBoardSessionToken();
    const res = await proxy(
      req('/dashboard', {
        headers: { cookie: `tourbillon_board_session=${token}`, authorization: `Bearer ${AGENT_TOKEN}` },
      }),
    );
    assert.equal(res.status, 307);
  });
});
