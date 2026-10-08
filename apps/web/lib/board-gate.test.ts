/**
 * #105: central board gate (getActiveCompanyOrNull / getActiveCompany / verifyMobileToken).
 * Real lib/company.ts + lib/mobile-auth.ts; db, shared and next/headers are mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const BOARD_SECRET = 'test-operator-secret-105';
const SESSION_COOKIE = 'tourbillon_board_session';
const AGENT_TOKEN = `pm_run_${Buffer.from(
  JSON.stringify({ runId: 'r1', agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;

// Mirrors lib/board-auth.ts key derivation (kept local so this file also runs against main).
function sessionKey(secret: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', 'tourbillon-board-session-v1').update(secret).digest());
}
async function sessionToken(opts: { secret?: string; exp?: string | number; typ?: string } = {}) {
  return new SignJWT({ typ: opts.typ ?? 'tourbillon_board_session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(sessionKey(opts.secret ?? BOARD_SECRET));
}
async function boardJwt(companyId: string) {
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(process.env.BETTER_AUTH_SECRET || 'change-me-in-production'));
}

const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = {
  cookies: {},
  headers: {},
};

describe('#105 central board gate', () => {
  let company: typeof import('./company');
  let mobileAuth: typeof import('./mobile-auth');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const companies = new Map([['company-a', { id: 'company-a', name: 'A' }]]);
    Module.prototype.require = function (id: string) {
      if (id === 'next/headers') {
        return {
          cookies: async () => ({
            get: (name: string) =>
              name in reqState.cookies ? { name, value: reqState.cookies[name] } : undefined,
            set: () => {},
            delete: () => {},
          }),
          headers: async () => new Headers(reqState.headers),
        };
      }
      if (id === '@tourbillon/db') {
        return {
          companies: { id: 'id', name: 'name' },
          db: {
            query: {
              companies: {
                findFirst: async ({ where }: { where: { val: string } }) => companies.get(where.val),
              },
            },
          },
        };
      }
      if (id === '@tourbillon/shared') {
        return {
          ensureCompanyWorkspace: async () => {},
          mergeCompanySettings: (a: unknown) => a,
          parseCompanySettings: (a: unknown) => a,
        };
      }
      if (id === 'drizzle-orm') {
        return { eq: (_c: unknown, val: unknown) => ({ val }), asc: (c: unknown) => c };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    company = await import('./company');
    mobileAuth = await import('./mobile-auth');
  });

  beforeEach(() => {
    reqState.cookies = {};
    reqState.headers = {};
    process.env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-not-default';
  });

  it('cookie-only (active_company_id, no board session) is not board', async () => {
    reqState.cookies = { active_company_id: 'company-a' };
    assert.equal(await company.getActiveCompanyOrNull(), null);
    await assert.rejects(() => company.getActiveCompany(), { name: 'ActiveCompanyError' });
  });

  it('forged session cookie (wrong key) is not board', async () => {
    reqState.cookies = {
      active_company_id: 'company-a',
      [SESSION_COOKIE]: await sessionToken({ secret: 'attacker-guess' }),
    };
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('garbage session cookie is not board', async () => {
    reqState.cookies = { active_company_id: 'company-a', [SESSION_COOKIE]: 'not-a-jwt' };
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('expired session cookie is not board', async () => {
    reqState.cookies = {
      active_company_id: 'company-a',
      [SESSION_COOKIE]: await sessionToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
    };
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('session cookie with the wrong typ claim is not board', async () => {
    reqState.cookies = {
      active_company_id: 'company-a',
      [SESSION_COOKIE]: await sessionToken({ typ: 'something-else' }),
    };
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('rotating TOURBILLON_BOARD_SECRET invalidates existing sessions', async () => {
    reqState.cookies = { active_company_id: 'company-a', [SESSION_COOKIE]: await sessionToken() };
    process.env.TOURBILLON_BOARD_SECRET = 'rotated-secret';
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('env unset: no session can be valid (fail closed)', async () => {
    reqState.cookies = { active_company_id: 'company-a', [SESSION_COOKIE]: await sessionToken() };
    delete process.env.TOURBILLON_BOARD_SECRET;
    assert.equal(await company.getActiveCompanyOrNull(), null);
  });

  it('agent run token + valid board session cookie is not board', async () => {
    reqState.cookies = { active_company_id: 'company-a', [SESSION_COOKIE]: await sessionToken() };
    reqState.headers = { authorization: `Bearer ${AGENT_TOKEN}` };
    assert.equal(await company.getActiveCompanyOrNull(), null);
    assert.equal(await company.getActiveCompanyOrNull('company-a'), null);
  });

  it('valid board session + company cookie resolves the company', async () => {
    reqState.cookies = { active_company_id: 'company-a', [SESSION_COOKIE]: await sessionToken() };
    assert.equal((await company.getActiveCompanyOrNull())?.id, 'company-a');
    assert.equal((await company.getActiveCompany()).id, 'company-a');
  });

  it('valid board JWT override resolves the company', async () => {
    const req = new NextRequest('http://localhost/api/x', {
      headers: { 'X-Company-Token': await boardJwt('company-a') },
    });
    const id = await mobileAuth.verifyMobileToken(req);
    assert.equal(id, 'company-a');
    assert.equal((await company.getActiveCompanyOrNull(id))?.id, 'company-a');
  });

  it('requireBoardSession (server-action guard, B1): throws without a valid session', async () => {
    reqState.cookies = { active_company_id: 'company-a' };
    await assert.rejects(() => company.requireBoardSession(), { name: 'BoardSessionRequiredError' });
    reqState.cookies = { [SESSION_COOKIE]: await sessionToken({ secret: 'attacker-guess' }) };
    await assert.rejects(() => company.requireBoardSession(), { name: 'BoardSessionRequiredError' });
    reqState.cookies = { [SESSION_COOKIE]: await sessionToken() };
    reqState.headers = { authorization: 'Bearer pm_run_malformed' };
    await assert.rejects(() => company.requireBoardSession(), { name: 'BoardSessionRequiredError' });
    reqState.headers = {};
    await company.requireBoardSession();
  });

  it('agent run token + valid board JWT: verifyMobileToken returns null', async () => {
    const req = new NextRequest('http://localhost/api/x', {
      headers: {
        'X-Company-Token': await boardJwt('company-a'),
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
    });
    assert.equal(await mobileAuth.verifyMobileToken(req), null);
  });
});
