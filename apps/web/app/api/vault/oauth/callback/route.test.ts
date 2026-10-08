/** #109 review S3: OAuth callback redirects must be absolute (a relative NextResponse.redirect → 500). */
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
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return { getActiveCompany: async () => ({ id: 'company-a' }) };
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
    it(`${query || '(no params)'} → absolute redirect to /settings?${expected}`, async () => {
      const res = await GET(get(query));
      assert.equal(res.status, 307);
      assert.equal(res.headers.get('location'), `http://localhost:3002/settings?${expected}`);
    });
  }
});
