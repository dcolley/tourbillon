import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { verifyMobileToken } from './mobile-auth';

// Must match the secret used in mobile-auth.ts
const SESSION_SECRET = new TextEncoder().encode(
  process.env.BETTER_AUTH_SECRET || 'change-me-in-production'
);

async function createMockRequest(headers: Record<string, string> = {}): Promise<Request> {
  return new Request('http://localhost:3002/api/test', { headers });
}

describe('verifyMobileToken', () => {
  it('returns null when no X-Company-Token header present', async () => {
    const req = await createMockRequest();
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, null);
  });

  it('returns null for invalid token', async () => {
    const req = await createMockRequest({
      'X-Company-Token': 'invalid-token-string',
    });
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, null);
  });

  it('returns null for malformed JWT', async () => {
    const req = await createMockRequest({
      'X-Company-Token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.malformed',
    });
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, null);
  });

  it('returns companyId for valid token', async () => {
    const token = await new SignJWT({ companyId: 'company-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(SESSION_SECRET);

    const req = await createMockRequest({
      'X-Company-Token': token,
    });
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, 'company-123');
  });

  it('returns null for expired token', async () => {
    const token = await new SignJWT({ companyId: 'company-456' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('0s') // Already expired
      .sign(SESSION_SECRET);

    const req = await createMockRequest({
      'X-Company-Token': token,
    });
    
    // Wait a tick to ensure expiration
    await new Promise((resolve) => setTimeout(resolve, 10));
    
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, null);
  });

  it('returns null for token without companyId claim', async () => {
    const token = await new SignJWT({ userId: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(SESSION_SECRET);

    const req = await createMockRequest({
      'X-Company-Token': token,
    });
    const result = await verifyMobileToken(req as any);
    assert.strictEqual(result, null);
  });
});
