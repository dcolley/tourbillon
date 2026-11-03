/**
 * S308-S1 / S308-S2 - vault refresh write-back failure + reauth pins (Refs #304).
 *
 * Background: each scope block (agent / company_user / company) in
 * vault-credentials.ts used to wrap BOTH the OAuth token refresh and the
 * subsequent DB write-back in one try. A write-back failure after a
 * SUCCESSFUL refresh was therefore caught by the "Failed to decrypt …
 * credential" catch: resolveVaultSecret returned null, dropped the rotated
 * tokens, and never set needsReauth. With a provider that rotates refresh
 * tokens, the stored token was then dead with no reauth signal.
 *
 * S308-S1 pins (behaviour, per scope): when the write-back (the update
 * carrying encryptedValue) rejects after a successful refresh -
 *   - the refreshed tokens still reach the caller (documented choice: the
 *     refresh genuinely succeeded, so the current wake keeps working with
 *     live credentials instead of a null that looks like "unconfigured"),
 *   - the DB is flagged with a follow-up needsReauth:true update (the
 *     rotated-token loss is made visible instead of silently kept stale),
 *   - the console.error is accurate ("Failed to persist refreshed …
 *     credential") and never the misleading "Failed to decrypt",
 *   - if the flag update ALSO rejects, resolveVaultSecret must still not
 *     throw.
 *
 * S308-S2 pins (behaviour, per scope × three refresh-failure modes): when
 * refreshOAuthToken returns null (HTTP failure, provider error payload, or
 * throwing fetch), resolveVaultSecret returns null and exactly one
 * needsReauth:true update reaches the DB - no token is returned.
 *
 * Mutants (measured RED, see PR body):
 *   - collapse the split catch back into the original single try → S308-S1 RED.
 *   - remove the needsReauth update from the refresh-failure branch → S308-S2 RED.
 *
 * Same harness as vault-credentials-304-softs.test.ts (the repo avoids
 * mock.module): seed the require-cache for the live './client' before
 * requiring the module under test, stub fetch, and set/restore the vault +
 * GitHub OAuth env around the suite.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, after, afterEach } from 'node:test';
import type { OAuthTokens } from '@tourbillon/shared/vault-types';

const require_ = createRequire(import.meta.url);

// aes-256-gcm key: 64 hex chars -> 32 bytes (same fixture as the 304-softs suite).
const savedVaultKey = process.env.VAULT_ENCRYPTION_KEY;
// refreshOAuthToken bails out early ("GitHub OAuth credentials not configured")
// unless both client credentials are present - set/restore around this suite.
const savedGithubId = process.env.GITHUB_OAUTH_CLIENT_ID;
const savedGithubSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';

interface UpdatePatch {
  encryptedValue?: string;
  needsReauth?: boolean;
  updatedAt?: Date;
}

// Every update(...).set(patch) call is recorded BEFORE the where() promise is
// built, so a rejected write-back still shows up as an attempt.
let updateAttempts: UpdatePatch[] = [];
let failTokenWriteBack = false; // updates carrying encryptedValue reject
let failReauthFlagUpdate = false; // needsReauth-only updates reject
let nextCredentialRow: Record<string, unknown> | null = null;

// Fake db: vault-credentials only ever calls findFirst / update().set().where().
const fakeDb = {
  query: {
    vaultSecrets: {
      findFirst: async () => nextCredentialRow,
    },
  },
  update: () => ({
    set: (patch: UpdatePatch) => {
      updateAttempts.push(patch);
      const rejects =
        (failTokenWriteBack && patch.encryptedValue !== undefined) ||
        (failReauthFlagUpdate && patch.encryptedValue === undefined && patch.needsReauth === true);
      return {
        where: () =>
          rejects ? Promise.reject(new Error('injected db failure')) : Promise.resolve(),
      };
    },
  }),
};

// Seed the require-cache for the live './client' (it builds a postgres pool at
// module load and validates DATABASE_URL) BEFORE requiring the module under
// test, so the write-back paths never touch a socket. Same recipe as
// vault-credentials-304-softs.test.ts.
{
  const clientPath = require_.resolve('./client');
  require_.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: { db: fakeDb },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
}

type VaultCredentialsModule = typeof import('./vault-credentials');
type VaultEncryptionModule = typeof import('@tourbillon/shared/vault-encryption');
const vault = require_('./vault-credentials') as VaultCredentialsModule;
const { encryptCredential } = require_(
  '@tourbillon/shared/vault-encryption',
) as VaultEncryptionModule;

after(() => {
  if (savedVaultKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
  else process.env.VAULT_ENCRYPTION_KEY = savedVaultKey;
  if (savedGithubId === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
  else process.env.GITHUB_OAUTH_CLIENT_ID = savedGithubId;
  if (savedGithubSecret === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  else process.env.GITHUB_OAUTH_CLIENT_SECRET = savedGithubSecret;
});

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
let logged: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  updateAttempts = [];
  failTokenWriteBack = false;
  failReauthFlagUpdate = false;
  nextCredentialRow = null;
});

function captureErrors(): void {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
}

function stubTokenEndpoint(accessToken: string): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      access_token: accessToken,
      refresh_token: 'rt-refreshed',
      expires_in: 3600,
      scope: 'repo',
    }),
  })) as unknown as typeof fetch;
}

function stubTokenEndpointHttpFailure(): void {
  globalThis.fetch = (async () => ({
    ok: false,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

function stubTokenEndpointProviderError(): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ error: 'bad_verification_code' }),
  })) as unknown as typeof fetch;
}

function stubTokenEndpointThrows(): void {
  globalThis.fetch = (() => {
    throw new Error('injected network failure');
  }) as unknown as typeof fetch;
}

function expiredOauthRow(id: string): Record<string, unknown> {
  return {
    id,
    authType: 'oauth',
    needsReauth: false,
    encryptedValue: encryptCredential({
      accessToken: 'expired-access',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 60_000,
    }),
  };
}

interface ScopeCase {
  label: string; // scope name as stored in vaultSecrets.scope
  word: string; // the word used in the per-scope console.error messages
  credId: string;
  ctx: Parameters<VaultCredentialsModule['resolveVaultSecret']>[0];
}

const SCOPES: ScopeCase[] = [
  {
    label: 'agent',
    word: 'agent',
    credId: 'cred-agent',
    ctx: { companyId: 'c-1', serverId: 'github-mcp', agentId: 'a-1' },
  },
  {
    label: 'company_user',
    word: 'user',
    credId: 'cred-user',
    ctx: { companyId: 'c-1', serverId: 'github-mcp', userId: 'u-1' },
  },
  {
    label: 'company',
    word: 'company',
    credId: 'cred-company',
    ctx: { companyId: 'c-1', serverId: 'github-mcp' },
  },
];

describe('S308-S1 - write-back failure after a successful refresh (Refs #304)', () => {
  for (const s of SCOPES) {
    it(`${s.label}: live tokens returned, needsReauth flagged, accurate log`, async () => {
      nextCredentialRow = expiredOauthRow(s.credId);
      stubTokenEndpoint(`fresh-${s.label}`);
      failTokenWriteBack = true;
      captureErrors();

      const result = await vault.resolveVaultSecret(s.ctx);

      // Documented choice: the refresh succeeded, so the caller gets the live
      // rotated tokens; collapsing this to null is the mutant the brief names.
      assert.notEqual(result, null, 'a failed write-back must not discard refreshed tokens');
      const tokens = result as OAuthTokens;
      assert.equal(tokens.accessToken, `fresh-${s.label}`);
      assert.equal(tokens.refreshToken, 'rt-refreshed');
      assert.equal(typeof tokens.expiresAt, 'number');
      assert.ok((tokens.expiresAt as number) > Date.now());

      // The rotated-token loss is made visible: write-back attempted, then
      // flagged for reauth so the stale stored row is not silently retried.
      assert.equal(updateAttempts.length, 2, 'write-back attempt followed by needsReauth flag');
      assert.equal(typeof updateAttempts[0].encryptedValue, 'string');
      assert.equal(updateAttempts[1].needsReauth, true);
      assert.equal(updateAttempts[1].encryptedValue, undefined);

      // Accurate log - the old single-try catch mislabelled this as decryption.
      assert.ok(
        logged.some((m) => m.includes(`Failed to persist refreshed ${s.word} credential`)),
        `expected an accurate persist-failure log, got: ${JSON.stringify(logged)}`,
      );
      assert.ok(
        !logged.some((m) => m.includes('Failed to decrypt')),
        `write-back failure must not be logged as a decrypt failure: ${JSON.stringify(logged)}`,
      );
    });

    it(`${s.label}: survives a second failure on the needsReauth flag update`, async () => {
      nextCredentialRow = expiredOauthRow(s.credId);
      stubTokenEndpoint(`fresh-${s.label}`);
      failTokenWriteBack = true;
      failReauthFlagUpdate = true;
      captureErrors();

      const result = await vault.resolveVaultSecret(s.ctx);

      assert.notEqual(
        result,
        null,
        'resolveVaultSecret must not throw when the needsReauth flag update also fails',
      );
      const tokens = result as OAuthTokens;
      assert.equal(tokens.accessToken, `fresh-${s.label}`);
      assert.equal(updateAttempts.length, 2, 'both the write-back and the flag were attempted');
      assert.ok(
        logged.some((m) => m.includes(`Failed to persist refreshed ${s.word} credential`)),
        `expected an accurate persist-failure log, got: ${JSON.stringify(logged)}`,
      );
      assert.ok(
        !logged.some((m) => m.includes('Failed to decrypt')),
        `write-back failure must not be logged as a decrypt failure: ${JSON.stringify(logged)}`,
      );
    });
  }
});

describe('S308-S2 - refreshOAuthToken returning null sets needsReauth (Refs #304)', () => {
  const failureModes = [
    { name: 'HTTP failure', stub: stubTokenEndpointHttpFailure },
    { name: 'provider error payload', stub: stubTokenEndpointProviderError },
    { name: 'fetch throws', stub: stubTokenEndpointThrows },
  ];
  for (const s of SCOPES) {
    for (const mode of failureModes) {
      it(`${s.label}: ${mode.name} -> null + needsReauth:true`, async () => {
        nextCredentialRow = expiredOauthRow(s.credId);
        mode.stub();
        captureErrors();

        const result = await vault.resolveVaultSecret(s.ctx);

        assert.equal(result, null, 'a failed refresh must not surface a token');
        assert.equal(updateAttempts.length, 1, 'exactly the needsReauth flag update');
        assert.equal(updateAttempts[0].needsReauth, true);
        assert.equal(updateAttempts[0].encryptedValue, undefined);
      });
    }
  }
});
