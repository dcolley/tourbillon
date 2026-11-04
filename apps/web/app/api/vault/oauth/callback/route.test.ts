/**
 * #109 review S3: OAuth callback redirects must not 500 (NextResponse.redirect rejects relative
 * URLs). #117 review B1: they must also not point at the server's bind address
 * (req.nextUrl.origin = localhost:3002 behind a TLS proxy) nor at a client-chosen Host /
 * X-Forwarded-Host. So the Location is a relative /settings path.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

describe('#106 vault OAuth callback redirects', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') return { db: { query: { vaultSecrets: { findFirst: async () => null } } } };
      if (id === '@tourbillon/db/schema') return { vaultSecrets: {} };
      if (id === '@tourbillon/shared/vault-encryption') return { encryptCredential: () => 'enc' };
      if (id === '@/lib/board-route-auth' || id.endsWith('/lib/board-route-auth')) {
        return { requireBoardCompany: async () => ({ ok: true, value: { id: 'company-a' } }) };
      }
      if (id === '@/lib/vault-oauth-nonce-store' || id.endsWith('/lib/vault-oauth-nonce-store')) {
        return { consumeOAuthNonce: async () => true };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ GET } = await import('./route'));
    // #112: the callback fails closed without a real secret; these cases test redirects after that.
    process.env.BETTER_AUTH_SECRET = 'real-better-auth-secret-for-callback-tests-0123';
    Module.prototype.require = originalRequire;
  });

  const get = (query: string) => new NextRequest(`http://localhost:3002/api/vault/oauth/callback${query}`);

  for (const [query, expected] of [
    ['?error=access_denied', 'oauth_error=access_denied'],
    ['', 'oauth_error=missing_parameters'],
    ['?code=c&state=%%%', 'oauth_error=invalid_state'],
    [
      `?code=c&state=${Buffer.from(JSON.stringify({ payload: '{}', signature: 'bad' })).toString('base64')}`,
      'oauth_error=invalid_state_signature',
    ],
  ] as const) {
    it(`${query || '(no params)'} → relative redirect to /settings?${expected}`, async () => {
      const res = await GET(get(query));
      assert.equal(res.status, 307);
      assert.equal(res.headers.get('location'), `/settings?${expected}`);
    });
  }

  it('B1: behind a proxy with spoofed Host / X-Forwarded-Host, Location is never evil.example nor localhost', async () => {
    const env = process.env as Record<string, string | undefined>;
    const savedUrl = env.BETTER_AUTH_URL;
    env.BETTER_AUTH_URL = 'https://tourbillon.example.test';
    try {
      for (const query of ['?error=access_denied', '', '?code=c&state=%%%']) {
        // The server sees its own bind address as the URL (as Next does behind a TLS proxy).
        const req = new NextRequest(`http://localhost:3002/api/vault/oauth/callback${query}`, {
          headers: {
            host: 'evil.example',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'https',
            forwarded: 'host=evil.example;proto=https',
          },
        });
        const res = await GET(req);
        assert.equal(res.status, 307);
        const location = res.headers.get('location') ?? '';
        assert.match(location, /^\/settings\?/);
        assert.doesNotMatch(location, /evil\.example/);
        assert.doesNotMatch(location, /localhost/);
      }
    } finally {
      if (savedUrl === undefined) delete env.BETTER_AUTH_URL;
      else env.BETTER_AUTH_URL = savedUrl;
    }
  });
});
