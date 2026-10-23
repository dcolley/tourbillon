/**
 * UI-1 route smoke test for `/`, `/assistant` and `/dashboard`:
 * - the route files exist and nothing else claims `/` (a page directly in app/(assistant)/
 *   would collide with app/page.tsx);
 * - `/` stays public and redirects to the stored view; `/assistant` and `/dashboard` need the
 *   same board session (proxy) and both layouts use CompanyGate.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';

const APP = fileURLToPath(new URL('.', import.meta.url));
const env = process.env as Record<string, string | undefined>;

describe('UI-1 view routes', () => {
  let proxy: typeof import('../proxy').proxy;
  let createBoardSessionToken: typeof import('../lib/board-auth').createBoardSessionToken;

  before(async () => {
    ({ proxy } = await import('../proxy'));
    ({ createBoardSessionToken } = await import('../lib/board-auth'));
  });
  beforeEach(() => {
    env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-ui1';
  });

  const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, { headers });

  it('route files exist for /, /assistant and /dashboard', () => {
    assert.ok(existsSync(join(APP, 'page.tsx')), 'app/page.tsx');
    assert.ok(existsSync(join(APP, '(assistant)', 'layout.tsx')), 'app/(assistant)/layout.tsx');
    assert.ok(existsSync(join(APP, '(assistant)', 'assistant', 'page.tsx')), '/assistant page');
    assert.ok(existsSync(join(APP, '(dashboard)', 'dashboard', 'page.tsx')), '/dashboard page');
    assert.ok(!existsSync(join(APP, '(assistant)', 'page.tsx')), 'no second page for /');
    assert.ok(!existsSync(join(APP, '(dashboard)', 'page.tsx')), 'no second page for /');
  });

  it('/ redirects client-side to the stored view', () => {
    const src = readFileSync(join(APP, 'page.tsx'), 'utf8');
    assert.match(src, /^'use client';/);
    assert.match(src, /router\.replace\(homeRedirectPath\(\)\)/);
  });

  it('both view layouts use CompanyGate and never list companies without a board session', () => {
    for (const group of ['(assistant)', '(dashboard)']) {
      const src = readFileSync(join(APP, group, 'layout.tsx'), 'utf8');
      assert.match(src, /<CompanyGate>/, group);
      assert.match(src, /isBoard \? listCompanies\(\) : Promise\.resolve\(\[\]\)/, group);
    }
  });

  it('without a session: / is public; /assistant and /dashboard redirect to /unlock', async () => {
    assert.equal((await proxy(req('/'))).headers.get('x-middleware-next'), '1');
    for (const p of ['/assistant', '/dashboard']) {
      const res = await proxy(req(p));
      assert.equal(res.status, 307, p);
      assert.equal(
        res.headers.get('location'),
        `http://localhost/unlock?next=${encodeURIComponent(p)}`,
        p,
      );
    }
  });

  it('with a valid board session: /assistant and /dashboard pass the proxy', async () => {
    const token = await createBoardSessionToken();
    const cookie = `tourbillon_board_session=${token}`;
    for (const p of ['/', '/assistant', '/dashboard']) {
      assert.equal((await proxy(req(p, { cookie }))).headers.get('x-middleware-next'), '1', p);
    }
  });
});
