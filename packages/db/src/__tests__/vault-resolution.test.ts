/**
 * Vault resolution API pins for packages/db/src/vault-credentials.ts.
 *
 * S303-S2 (Refs #303): ported from vitest to node:test. This file used to import
 * `describe/it/expect/beforeAll/vi` from 'vitest' while every other db test runs under
 * `tsx --test` (packages/db: `tsx --test $(find src -name "*.test.ts" | sort)`) — the
 * vitest import failed with "Cannot find module 'vitest'" and the whole file counted as
 * a failure in the db suite. Assertions are ported 1:1 (placeholder tests included):
 * no assertion was strengthened, weakened or dropped. The OAuth write-back behaviour
 * lives in the node:test sibling ../vault-credentials-304-softs.test.ts (#308).
 *
 * './client' is seeded into the require cache before the module under test loads (same
 * recipe as ../vault-credentials-304-softs.test.ts and
 * packages/scheduler/src/scheduler-main.test.ts): client.ts builds a postgres pool at
 * module load and validates DATABASE_URL, and this suite must not touch a socket.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// aes-256-gcm key: 64 hex chars -> 32 bytes (same fixture as the 304-softs sibling).
const savedVaultKey = process.env.VAULT_ENCRYPTION_KEY;
process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

const require_ = createRequire(import.meta.url);

// Seed the require cache for src/client.ts BEFORE loading the module under test, so
// the postgres driver is never constructed. Resolve './client' from the vault-credentials
// module's own directory (this file lives one level down in __tests__/).
{
  const fromVault = createRequire(path.join(HERE, '..', 'vault-credentials.ts'));
  const clientPath = fromVault.resolve('./client');
  require_.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
      // Only the shapes vault-credentials calls; nothing here opens a socket.
      db: {
        query: { vaultSecrets: { findFirst: async () => null } },
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      },
    },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
}

after(() => {
  if (savedVaultKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
  else process.env.VAULT_ENCRYPTION_KEY = savedVaultKey;
});

describe('vault-credentials', () => {
  before(() => {
    process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  describe('resolveVaultSecret', () => {
    it('should have correct resolution order', () => {
      // Resolution order per AC-V2.1:
      // 1. Agent-scoped credential (if agentId provided)
      // 2. User-scoped credential (if userId provided)
      // 3. Company-scoped credential
      // 4. Legacy settings.mcpCredentials (transition only)
      // 5. Environment variable fallback
      // 6. Return null if not found

      assert.ok(true); // Placeholder for DB-dependent test
    });

    it('should enforce scope semantics (AC-V2.2)', () => {
      // - company scope: any agent in company can read
      // - company_user scope: only matching userId
      // - agent scope: only matching agentId

      assert.ok(true); // Placeholder for DB-dependent test
    });
  });

  describe('API name', () => {
    it('resolveVaultSecret is primary API (PM decision)', () => {
      const { resolveVaultSecret } = require_('../vault-credentials');
      assert.equal(typeof resolveVaultSecret, 'function');
    });

    it('resolvePluginCredential is thin alias', () => {
      const { resolvePluginCredential, resolveVaultSecret } = require_('../vault-credentials');
      assert.equal(typeof resolvePluginCredential, 'function');
      // Both should exist
      assert.ok(resolvePluginCredential);
      assert.ok(resolveVaultSecret);
    });
  });

  describe('company_user scope (PM decision)', () => {
    it('is supported in API per PM decision #3', () => {
      const { getVaultCredentialStatus } = require_('../vault-credentials');

      // Should accept company_user scope
      assert.doesNotThrow(() => {
        const scope: 'company' | 'company_user' | 'agent' = 'company_user';
        assert.equal(scope, 'company_user');
        void getVaultCredentialStatus;
      });
    });
  });
});
