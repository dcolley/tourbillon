/**
 * S304-S1 — vault-encryption write-back in packages/db comes from shared (Refs #304).
 *
 * vault-credentials.ts had three OAuth token-refresh write-back sites that used a
 * `require` of `./vault-encryption` — a module that does not exist in packages/db
 * (it lives at `@tourbillon/shared/vault-encryption`). `next build` reported three
 * Module-not-found warnings against this file, and the write-back throws at runtime:
 * the failing require lands inside the try/catch, so MODULE_NOT_FOUND is swallowed
 * and resolveVaultSecret returns null instead of persisting the refreshed tokens.
 *
 * Pin (task-runner-<n>-softs convention — readFileSync source pins plus a
 * require-cache-stubbed behaviour pin; the repo avoids mock.module):
 *  1. The file contains no require-call at all, and never mentions the local
 *     module path (the forbidden spelling is assembled by concatenation below so
 *     this test file never holds it contiguously — the rg gate over packages/db
 *     must stay empty).
 *  2. encryptCredential is imported from '@tourbillon/shared/vault-encryption'.
 *  3. Exactly three write-back sites assign encryptCredential(refreshed); one in
 *     each of the agent / company_user / company scope slices. (S308-S3: now ONE
 *     site in resolveScopedCredential(row), which every scope slice calls.)
 *  4. Behaviour: for each scope, an expired OAuth credential refreshes and the
 *     captured encryptedValue round-trips through the SHARED decryptCredential
 *     back to the refreshed tokens.
 *  5. S314-S1 row-target pin: the fake db used to ignore `.where(...)`, so
 *     nothing pinned WHICH vaultSecrets row an update touches — a mutant
 *     targeting the wrong row id (the #314 gate's G13 class, e.g.
 *     `credentialId + '-x'`) survived 22/22. The harness now unpacks the real
 *     drizzle SQL handed to `.where()` and the behaviour tests assert the
 *     update targets the seeded credential's id.
 *
 * Mutant (per the brief): revert any of the three sites to a require of the local
 * module. That REDs the no-require-call pins (whole file + the site's slice + the
 * count-3 canonical pin) and the behaviour test for that scope — the require
 * throws inside the try, the catch returns null, no write-back is captured.
 *
 * S318-S1 sweep ledger (Refs #318, from the #318 gate comment): the gate
 * mutant-measured only the agent write-back + company refresh-failure flag. The
 * soft-pack-B gate injected wrong-id / wrong-column mutants at EVERY remaining
 * update site in vault-credentials.ts (company_user write-back, agent and
 * company_user refresh-failure flags, company write-back, plus a wrong-column
 * variant on company_user) and each RED'd exactly the scope's tests here and in
 * vault-credentials-308-softs.test.ts (matrix in the pack-B PR body).
 *
 * S318-S2 (Refs #318): the shared self-test below probes extractWhereTarget with
 * a known eq() so a drizzle bump that reshapes SQL.queryChunks internals fails
 * with a clear "harness broke" message instead of masquerading as row-target
 * regressions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, after, afterEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type { OAuthTokens } from '@tourbillon/shared/vault-types';
import { vaultSecrets } from './schema/vault-secrets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'vault-credentials.ts'), 'utf8');

// Forbidden spellings, assembled by concatenation so THIS file never contains a
// contiguous match for the build/gate grep (rg "require\(['\"]\./vault-encryption").
const Q = String.fromCharCode(39);
const LOCAL_MODULE_NEEDLE = './vault-' + 'encryption';
const LOCAL_REQUIRE_NEEDLE = 'require' + '(' + Q + LOCAL_MODULE_NEEDLE + Q + ')';
// require-call detector (regex source carries escapes, so it never matches itself).
const REQUIRE_CALL = new RegExp('require' + '\\s*\\(');

// aes-256-gcm key: 64 hex chars -> 32 bytes (same fixture as vault-resolution.test.ts).
const savedVaultKey = process.env.VAULT_ENCRYPTION_KEY;
process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
// refreshOAuthToken bails out early ("GitHub OAuth credentials not configured")
// unless both client credentials are present — set/restore around this suite.
const savedGithubId = process.env.GITHUB_OAUTH_CLIENT_ID;
const savedGithubSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';

const require_ = createRequire(import.meta.url);

interface UpdatePatch {
  encryptedValue?: string;
  needsReauth?: boolean;
  updatedAt?: Date;
}
const updatePatches: UpdatePatch[] = [];
let nextCredentialRow: Record<string, unknown> | null = null;

// S314-S1: the row each update attempt targets, recorded from the real drizzle
// SQL handed to `.where(...)`. Unpacked from the SQL's queryChunks: a Column
// chunk (has name + table) and a Param chunk (bound value). Non-throwing —
// mismatches surface as deepEqual diffs in the tests, never as exceptions
// inside the fake db (the production try/catches would swallow those).
interface WhereTarget {
  column?: string;
  value?: unknown;
}
const whereTargets: WhereTarget[] = [];

function extractWhereTarget(cond: unknown): WhereTarget {
  const chunks = (cond as { queryChunks?: unknown[] } | null | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) {
    return { column: 'expected-drizzle-sql', value: undefined };
  }
  const flat: Record<string, unknown>[] = [];
  const walk = (c: unknown): void => {
    if (c && typeof c === 'object') {
      flat.push(c as Record<string, unknown>);
      const nested = (c as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(nested)) nested.forEach(walk);
    }
  };
  chunks.forEach(walk);
  const columns = flat.filter((c) => typeof c.name === 'string' && c.table !== undefined);
  const params = flat.filter((c) => c.constructor?.name === 'Param' && 'value' in c);
  return {
    column: columns.length === 1 ? String(columns[0].name) : `expected-1-column-got-${columns.length}`,
    value: params.length === 1 ? params[0].value : `expected-1-param-got-${params.length}`,
  };
}

// Fake db: vault-credentials only ever calls findFirst / update().set().where().
const fakeDb = {
  query: {
    vaultSecrets: {
      findFirst: async () => nextCredentialRow,
    },
  },
  update: () => ({
    set: (patch: UpdatePatch) => {
      updatePatches.push(patch);
      whereTargets.push({});
      return {
        where: (cond: unknown) => {
          const target = whereTargets[whereTargets.length - 1];
          if (target) Object.assign(target, extractWhereTarget(cond));
          return Promise.resolve();
        },
      };
    },
  }),
};

// Seed the require-cache for the live './client' (it builds a postgres pool at
// module load and validates DATABASE_URL) BEFORE requiring the module under test,
// so the write-back paths never touch a socket. Same recipe as
// packages/scheduler/src/scheduler-main.test.ts.
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
const { encryptCredential, decryptCredential } = require_(
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
afterEach(() => {
  globalThis.fetch = originalFetch;
  updatePatches.length = 0;
  whereTargets.length = 0;
  nextCredentialRow = null;
});

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

async function expectRefreshedWriteBack(
  ctx: Parameters<VaultCredentialsModule['resolveVaultSecret']>[0],
  credId: string,
  expectedAccessToken: string,
): Promise<void> {
  const result = await vault.resolveVaultSecret(ctx);
  assert.ok(
    result !== null && typeof result === 'object',
    'expected refreshed OAuthTokens (a reverted write-back site throws inside the ' +
      'try/catch and resolveVaultSecret returns null)',
  );
  const tokens = result as OAuthTokens;
  assert.equal(tokens.accessToken, expectedAccessToken);
  assert.equal(tokens.refreshToken, 'rt-refreshed');
  assert.equal(tokens.scope, 'repo');
  assert.equal(typeof tokens.expiresAt, 'number');
  assert.ok((tokens.expiresAt as number) > Date.now());

  assert.equal(updatePatches.length, 1, 'exactly one write-back to vaultSecrets');
  const patch = updatePatches[0];
  assert.equal(patch.needsReauth, false);
  assert.equal(typeof patch.encryptedValue, 'string');
  // Round-trips through the SHARED decrypt -> proves the persisted value was
  // produced by the shared encryptCredential under the same VAULT_ENCRYPTION_KEY.
  assert.deepEqual(decryptCredential(patch.encryptedValue as string), tokens);
  // S314-S1: the write-back must hit the seeded row by id — a wrong-target
  // update would rotate the token onto a different vaultSecrets row entirely.
  assert.deepEqual(
    whereTargets[0],
    { column: 'id', value: credId },
    'the write-back must update the seeded credential row',
  );
}

function sliceBetween(start: string, end: string): string {
  const i = SRC.indexOf(start);
  assert.notEqual(i, -1, `start anchor missing: ${start}`);
  const j = SRC.indexOf(end, i);
  assert.notEqual(j, -1, `end anchor missing after start: ${end}`);
  return SRC.slice(i, j);
}

describe('vault-credentials-304-softs — encryptCredential comes from shared (Refs #304)', () => {
  describe('source pins', () => {
    it('contains no require-call and never names the local vault-encryption module', () => {
      assert.equal(
        REQUIRE_CALL.test(SRC),
        false,
        'vault-credentials.ts must import its crypto helpers, not require them',
      );
      assert.ok(!SRC.includes(LOCAL_REQUIRE_NEEDLE));
      assert.ok(!SRC.includes(LOCAL_MODULE_NEEDLE));
    });

    it('imports encryptCredential from @tourbillon/shared/vault-encryption', () => {
      assert.match(
        SRC,
        /import\s*\{[^}]*\bencryptCredential\b[^}]*\}\s*from\s*'@tourbillon\/shared\/vault-encryption'/,
      );
    });

    // S308-S3: the three per-scope copies collapsed into resolveScopedCredential(row). The #304
    // pin is unchanged in intent — every scope's refresh write-back encrypts via the SHARED helper
    // with no require — it now holds by construction: ONE write-back site, inside the helper, and
    // every scope routes through it (the behaviour tests below still cover each scope end to end).
    it('has exactly one encryptCredential(refreshed) write-back site, inside resolveScopedCredential', () => {
      const sites = SRC.match(/encryptedValue:\s*encryptCredential\(refreshed\)/g) ?? [];
      assert.equal(sites.length, 1, 'S308-S3: one shared write-back for agent / company_user / company');
      const helper = sliceBetween('async function resolveScopedCredential(', 'async function flagNeedsReauthAfterLostWriteBack(');
      assert.match(helper, /encryptedValue:\s*encryptCredential\(refreshed\)/, 'the write-back lives in the helper');
      assert.equal(REQUIRE_CALL.test(helper), false, 'the shared write-back must not fall back to a require');
    });

    it('each scope resolves its row through resolveScopedCredential (no per-scope copy of the write-back)', () => {
      const slices: Array<[string, string, string]> = [
        ['agent', "eq(vaultSecrets.scope, 'agent')", "resolveScopedCredential(agentCred, ctx.serverId, 'agent')"],
        ['company_user', "eq(vaultSecrets.scope, 'company_user')", "resolveScopedCredential(userCred, ctx.serverId, 'user')"],
        ['company', "eq(vaultSecrets.scope, 'company')", "resolveScopedCredential(companyCred, ctx.serverId, 'company')"],
      ];
      for (const [label, start, end] of slices) {
        const slice = sliceBetween(start, end);
        assert.doesNotMatch(slice, /encryptCredential\(/, `${label} scope must not carry its own write-back copy`);
        assert.equal(REQUIRE_CALL.test(slice), false, `${label} scope must not fall back to a require`);
      }
    });
  });

  describe('behaviour — OAuth refresh write-back persists shared-encrypted tokens', () => {
    it('agent scope', async () => {
      nextCredentialRow = expiredOauthRow('cred-agent');
      stubTokenEndpoint('fresh-agent');
      await expectRefreshedWriteBack(
        { companyId: 'c-1', serverId: 'github-mcp', agentId: 'a-1' },
        'cred-agent',
        'fresh-agent',
      );
    });

    it('company_user scope', async () => {
      nextCredentialRow = expiredOauthRow('cred-user');
      stubTokenEndpoint('fresh-user');
      await expectRefreshedWriteBack(
        { companyId: 'c-1', serverId: 'github-mcp', userId: 'u-1' },
        'cred-user',
        'fresh-user',
      );
    });

    it('company scope', async () => {
      nextCredentialRow = expiredOauthRow('cred-company');
      stubTokenEndpoint('fresh-company');
      await expectRefreshedWriteBack(
        { companyId: 'c-1', serverId: 'github-mcp' },
        'cred-company',
        'fresh-company',
      );
    });
  });
});

// S318-S2 (Refs #318): the fake-db `.where()` unpacker above duck-types drizzle
// 0.45 internals (SQL.queryChunks; Column chunks by name+table; Param chunks by
// constructor name). A drizzle bump that reshapes those internals would otherwise
// make every row-target assertion below fail as an apparent PRODUCT regression.
// This probe isolates the harness: it must unpack a known eq() to the exact
// { column, value } pair, or the failure message says "harness broke".
describe('vault-credentials-304-softs — S318-S2 where-extractor self-test (Refs #318)', () => {
  it('extractWhereTarget unpacks a known eq() to { column: "id", value }', () => {
    assert.deepEqual(
      extractWhereTarget(eq(vaultSecrets.id, 'probe-row-1')),
      { column: 'id', value: 'probe-row-1' },
      'HARNESS BROKEN: extractWhereTarget no longer unpacks drizzle eq() SQL — ' +
        'SQL.queryChunks internals changed (drizzle bump?). Row-target pins in ' +
        'this file are unreliable until the unpacker is fixed; do NOT read their ' +
        'failures as row-target regressions.',
    );
  });
});
