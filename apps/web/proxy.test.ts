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

  it('landing page and /unlock are public for GET; /health is not a web route (gated)', async () => {
    assert.equal((await proxy(req('/'))).headers.get('x-middleware-next'), '1');
    assert.equal((await proxy(req('/unlock'))).headers.get('x-middleware-next'), '1');
    assert.equal((await proxy(req('/health'))).status, 307);
  });

  it('B1: server action POST to an image-suffixed dynamic route without session → 401', async () => {
    for (const p of ['/agent/x.png', '/issue/A.svg', '/heartbeat/z.jpg', '/agent/new.png', '/project/x.ico']) {
      const res = await proxy(req(p, { method: 'POST', headers: { 'next-action': 'abc' } }));
      assert.equal(res.status, 401, p);
    }
  });

  it('B1: any Next-Action request without session → 401, even GET on a public path', async () => {
    assert.equal((await proxy(req('/', { headers: { 'next-action': 'abc' } }))).status, 401);
    assert.equal((await proxy(req('/unlock', { headers: { 'next-action': 'abc' } }))).status, 401);
    assert.equal((await proxy(req('/logo.svg', { method: 'POST', headers: { 'next-action': 'abc' } }))).status, 401);
  });

  it('B1: Next-Action with a valid session passes; with session + agent token → 401', async () => {
    const token = await createBoardSessionToken();
    const cookie = `tourbillon_board_session=${token}`;
    const ok = await proxy(req('/agent/x.png', { method: 'POST', headers: { cookie, 'next-action': 'abc' } }));
    assert.equal(ok.headers.get('x-middleware-next'), '1');
    const agent = await proxy(
      req('/agent/x.png', {
        method: 'POST',
        headers: { cookie, 'next-action': 'abc', authorization: `Bearer ${AGENT_TOKEN}` },
      }),
    );
    assert.equal(agent.status, 401);
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

  /**
   * B1: apply the EXPORTED matcher config exactly the way Next does: compile it with Next's own
   * getMiddlewareMatchers (build-time analysis) and evaluate with getMiddlewareRouteMatcher
   * (the runtime matcher, which also honours `has` conditions).
   */
  function nextMatcher() {
    const { config } = require('./proxy') as typeof import('./proxy');
    const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info');
    const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher');
    const matchers = getMiddlewareMatchers(config.matcher, {});
    const match = getMiddlewareRouteMatcher(matchers) as (
      pathname: string,
      req: { headers: Record<string, string>; cookies: Record<string, string> },
      query: Record<string, string>,
    ) => boolean;
    return (pathname: string, headers: Record<string, string> = {}) => match(pathname, { headers, cookies: {} }, {});
  }

  const PUBLIC_FILES = [
    '/logo.svg',
    '/icon.svg',
    '/favicon.ico',
    '/gears-working-cog-bronze-gear-mechanism-in-rim-mLskLLME.jpg',
  ];

  it('matcher (compiled by Next): image-suffixed dynamic routes and pages run the proxy', () => {
    const runs = nextMatcher();
    for (const p of [
      '/agent/x.png',
      '/issue/A.svg',
      '/heartbeat/z.jpg',
      '/goal/x.jpg',
      '/project/x.ico',
      '/heartbeat/x.webp',
      '/jobs/heartbeat/x.gif',
      '/agent/new.png',
      '/x.png',
      '/agent/logo.svg',
      '/logo.svg/x',
      '/api.png',
      '/dashboard',
      '/select-company',
      '/bullmq',
      '/agent/x',
      '/',
      '/unlock',
    ]) {
      assert.equal(runs(p), true, p);
    }
  });

  it('matcher (compiled by Next): only /api, Next assets and the named public files are exempt', () => {
    const runs = nextMatcher();
    for (const p of ['/api/mobile/companies', '/api/auth/login', '/_next/static/x.js', '/_next/image', ...PUBLIC_FILES]) {
      assert.equal(runs(p), false, p);
    }
  });

  it('matcher (compiled by Next): exempt files listed in the matcher exist in public/ (or app/icon.svg)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    for (const p of PUBLIC_FILES.filter((f) => f !== '/favicon.ico')) {
      const inPublic = fs.existsSync(path.join(__dirname, 'public', p));
      const appIcon = p === '/icon.svg' && fs.existsSync(path.join(__dirname, 'app', 'icon.svg'));
      assert.ok(inPublic || appIcon, `${p} is exempt but does not exist`);
    }
  });

  it('matcher (compiled by Next): any Next-Action request runs the proxy, even on exempt paths', () => {
    const runs = nextMatcher();
    for (const p of [...PUBLIC_FILES, '/_next/static/x.js', '/api/mobile/companies', '/agent/x.png', '/']) {
      assert.equal(runs(p, { 'next-action': 'abc' }), true, p);
    }
  });

  it('approval details page (/approval/<id> and legacy /approval?id=): board only', async () => {
    const token = await createBoardSessionToken();
    for (const path of ['/approval/a0000001-0000-4000-8000-000000000001', '/approval?id=a0000001-0000-4000-8000-000000000001']) {
      const anon = await proxy(req(path));
      assert.equal(anon.status, 307, path);
      assert.match(anon.headers.get('location') ?? '', /\/unlock\?next=/);
      const agent = await proxy(
        req(path, { headers: { cookie: `tourbillon_board_session=${token}`, authorization: `Bearer ${AGENT_TOKEN}` } }),
      );
      assert.equal(agent.status, 307, `${path} agent bearer`);
      const board = await proxy(req(path, { headers: { cookie: `tourbillon_board_session=${token}` } }));
      assert.equal(board.headers.get('x-middleware-next'), '1', `${path} board`);
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
