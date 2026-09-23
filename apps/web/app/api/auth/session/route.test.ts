import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './route';

// Mock dependencies
const mockDb = {
  select: mock.fn(() => mockDb),
  from: mock.fn(() => mockDb),
  innerJoin: mock.fn(() => mockDb),
  where: mock.fn(() => mockDb),
  limit: mock.fn(() => Promise.resolve([])),
};

const mockAuth = {
  handler: mock.fn(async () => new Response(JSON.stringify({}), { status: 401 })),
};

mock.module('@tourbillon/db', {
  namedExports: {
    db: mockDb,
    eq: mock.fn(() => 'eq'),
    or: mock.fn(() => 'or'),
    session: { id: 'id', token: 'token', expiresAt: 'expiresAt', userId: 'userId' },
    user: { id: 'id', email: 'email', name: 'name' },
  },
});

mock.module('@/lib/auth', {
  namedExports: { auth: mockAuth },
});

describe('GET /api/auth/session', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('returns 401 when no authorization header and no cookie', async () => {
    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 401);
    assert.strictEqual(body.authenticated, false);
  });

  it('returns 401 for empty Bearer token', async () => {
    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 401);
    assert.strictEqual(body.authenticated, false);
    assert.strictEqual(body.error, 'No active session');
  });

  it('returns 401 when Bearer token is not found in database', async () => {
    mockDb.limit = mock.fn(() => Promise.resolve([]));

    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer invalid-token',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 401);
    assert.strictEqual(body.authenticated, false);
    assert.strictEqual(body.error, 'No active session');
  });

  it('returns 401 when session is expired', async () => {
    const expiredDate = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
    
    mockDb.limit = mock.fn(() =>
      Promise.resolve([
        {
          sessionId: 'session-123',
          sessionToken: 'valid-token',
          sessionExpiresAt: expiredDate,
          userId: 'user-456',
          userEmail: 'test@example.com',
          userName: 'Test User',
        },
      ])
    );

    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer valid-token',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 401);
    assert.strictEqual(body.authenticated, false);
    assert.strictEqual(body.error, 'No active session');
  });

  it('returns 200 with user data for valid Bearer token', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24); // 1 day from now
    
    mockDb.limit = mock.fn(() =>
      Promise.resolve([
        {
          sessionId: 'session-123',
          sessionToken: 'valid-token',
          sessionExpiresAt: futureDate,
          userId: 'user-456',
          userEmail: 'test@example.com',
          userName: 'Test User',
        },
      ])
    );

    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer valid-token',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.authenticated, true);
    assert.deepStrictEqual(body.user, {
      id: 'user-456',
      email: 'test@example.com',
      name: 'Test User',
    });
  });

  it('accepts Bearer token with session ID instead of token', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
    
    mockDb.limit = mock.fn(() =>
      Promise.resolve([
        {
          sessionId: 'session-789',
          sessionToken: 'token-xyz',
          sessionExpiresAt: futureDate,
          userId: 'user-999',
          userEmail: 'session@example.com',
          userName: 'Session User',
        },
      ])
    );

    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer session-789',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.authenticated, true);
    assert.strictEqual(body.user.id, 'user-999');
  });

  it('is case-insensitive for Bearer prefix', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
    
    mockDb.limit = mock.fn(() =>
      Promise.resolve([
        {
          sessionId: 'session-abc',
          sessionToken: 'token-def',
          sessionExpiresAt: futureDate,
          userId: 'user-123',
          userEmail: 'case@example.com',
          userName: 'Case User',
        },
      ])
    );

    const req = new Request('http://localhost:3002/api/auth/session', {
      method: 'GET',
      headers: {
        Authorization: 'bearer token-def',
      },
    });

    const response = await GET(req as any);
    const body = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.authenticated, true);
  });
});
