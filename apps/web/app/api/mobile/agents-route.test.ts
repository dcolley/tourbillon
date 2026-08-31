import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { verifyMobileToken } from '../../../lib/mobile-auth';
// NextRequest used for JWT header checks only.

const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function tokenFor(companyId: string): Promise<string> {
  return new SignJWT({ companyId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SESSION_SECRET);
}

describe('mobile agent route token isolation', () => {
  it('verifyMobileToken returns company A and not company B', async () => {
    const tokenA = await tokenFor('company-a');
    const tokenB = await tokenFor('company-b');
    const reqA = new NextRequest('http://localhost/api/mobile/agents/ceo', {
      headers: { 'x-company-token': tokenA },
    });
    const reqB = new NextRequest('http://localhost/api/mobile/agents/ceo', {
      headers: { 'x-company-token': tokenB },
    });
    assert.equal(await verifyMobileToken(reqA), 'company-a');
    assert.equal(await verifyMobileToken(reqB), 'company-b');
  });

  it('rejects missing token', async () => {
    const req = new NextRequest('http://localhost/api/mobile/agents/ceo');
    assert.equal(await verifyMobileToken(req), null);
  });
});

describe('mobile agent PATCH auth', () => {
  it('PATCH without a token is unauthorized at the JWT layer', async () => {
    const req = new NextRequest('http://localhost/api/mobile/agents/ceo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'profile', name: 'CEO', urlKey: 'ceo' }),
    });
    assert.equal(await verifyMobileToken(req), null);
  });
});
