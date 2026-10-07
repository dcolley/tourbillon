/** #105: POST /api/board/session issues a signed, httpOnly, short-lived board session cookie. */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const BOARD_SECRET = 'test-operator-secret-105';
const AGENT_TOKEN = `pm_run_${Buffer.from(
  JSON.stringify({ runId: 'r1', agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;
const env = process.env as Record<string, string | undefined>;

function post(headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest('http://localhost/api/board/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('#105 /api/board/session', () => {
  let route: typeof import('./route');
  let boardAuth: typeof import('../../../../lib/board-auth');

  before(async () => {
    route = await import('./route');
    boardAuth = await import('../../../../lib/board-auth');
  });

  beforeEach(() => {
    env.NODE_ENV = 'test';
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
  });

  it('no secret → 401, no cookie', async () => {
    const res = await route.POST(post({}, {}));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('wrong secret → 401', async () => {
    assert.equal((await route.POST(post({}, { secret: 'wrong' }))).status, 401);
    assert.equal((await route.POST(post({ 'X-Board-Secret': 'wrong' }))).status, 401);
  });

  it('env unset → 401 (fail closed)', async () => {
    delete env.TOURBILLON_BOARD_SECRET;
    assert.equal((await route.POST(post({}, { secret: 'anything' }))).status, 401);
  });

  it('agent run token → 403 even with the right secret', async () => {
    const res = await route.POST(post({ Authorization: `Bearer ${AGENT_TOKEN}` }, { secret: BOARD_SECRET }));
    assert.equal(res.status, 403);
  });

  it('valid secret → signed httpOnly short-lived cookie that verifies', async () => {
    const res = await route.POST(post({}, { secret: BOARD_SECRET }));
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^tourbillon_board_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Max-Age=43200/);
    assert.doesNotMatch(cookie, /Secure/);
    const token = cookie.split(';')[0].split('=')[1];
    assert.equal(await boardAuth.verifyBoardSessionToken(token), true);
  });

  it('valid secret over https (x-forwarded-proto) → Secure cookie', async () => {
    const res = await route.POST(post({ 'X-Board-Secret': BOARD_SECRET, 'x-forwarded-proto': 'https' }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  });

  it('DELETE clears the cookie', async () => {
    const res = await route.DELETE();
    assert.match(res.headers.get('set-cookie') ?? '', /tourbillon_board_session=;.*Max-Age=0/);
  });
});
