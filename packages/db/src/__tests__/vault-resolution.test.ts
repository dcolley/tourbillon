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
 * S313-S3 (Refs #303): the three tautological placeholders left by that port —
 * two `assert.ok(true)` bodies plus a `void getVaultCredentialStatus` scope check —
 * are replaced by real resolution-order / scope pins. The seeded fake db now decodes
 * each captured drizzle `where` into a column->value map (see decodeWhere) and
 * answers it by the scope it actually asked for, so:
 *   - AC-V2.1 order (agent -> company_user -> company, first hit short-circuits),
 *   - AC-V2.2 scope filters (each probe carries exactly its owner columns; a row is
 *     visible only to a query filtering its owner),
 *   - the needsReauth skip, and the legacy settings/env fallback chain
 *     (AC-V2.1 steps 4-6 via resolveMcpCredential with 'buffer-mcp'),
 *   - getVaultCredentialStatus's scope/userId filters
 * are all pinned behaviourally. The decoder asserts non-empty maps, so a drizzle
 * internals change fails these tests loudly rather than silently.
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
import { describe, it, before, after, beforeEach } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// aes-256-gcm key: 64 hex chars -> 32 bytes (same fixture as the 304-softs sibling).
const savedVaultKey = process.env.VAULT_ENCRYPTION_KEY;
process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);

const require_ = createRequire(import.meta.url);

/** Decoded column->value maps, in call order, of every findFirst the suite captured. */
const queries: Array<Record<string, unknown>> = [];
/** Rows keyed by their scope; visibility also requires the query to filter the owner. */
let vaultRows: Record<string, Record<string, unknown>> = {};

/**
 * Walk a drizzle `and()/eq()` SQL tree and collect { column.name: Param.value } pairs.
 * Drizzle 0.45 lays an eq out as queryChunks [StringChunk, column, StringChunk, Param,
 * StringChunk]; nested and() nodes expose further queryChunks. If the internals move,
 * decodeWhere returns {} and the per-test deepEqual pins fail — loud, not vacuous.
 */
function decodeWhere(where: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isColumn = (n: any): n is { name: string } =>
    !!n && typeof n === 'object' && typeof n.name === 'string' && !!n.table && !!n.columnType;
  const isParam = (n: any): n is { value: unknown } =>
    !!n && typeof n === 'object' && 'value' in n && 'encoder' in n;
  const visit = (chunks: unknown[]) => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as any;
      if (chunk && Array.isArray(chunk.queryChunks)) visit(chunk.queryChunks);
      else if (isColumn(chunk) && isParam(chunks[i + 2])) {
        // Column names are the schema's snake_case names; camelCase keeps assertions readable.
        const key = String(chunk.name).replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
        out[key] = (chunks[i + 2] as { value: unknown }).value;
      }
    }
  };
  visit((where as any)?.queryChunks ?? []);
  assert.ok(Object.keys(out).length > 0, 'decodeWhere produced an empty map — drizzle internals moved; update the decoder before trusting these pins');
  return out;
}

// Fake db: vault-credentials only ever calls findFirst / update().set().where().
const fakeDb = {
  query: {
    vaultSecrets: {
      findFirst: async (args: { where: unknown }) => {
        const q = decodeWhere(args.where);
        queries.push(q);
        const row = q.scope === undefined ? undefined : vaultRows[String(q.scope)];
        if (!row) return null;
        // Owner-field visibility: a row bound to an owner is only returned to a query
        // that filters on that same owner value — the fake cannot serve a row the real
        // SQL's WHERE would have excluded.
        if (row.agentId !== undefined && row.agentId !== q.agentId) return null;
        if (row.userId !== undefined && row.userId !== q.userId) return null;
        return row;
      },
    },
  },
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};

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
    exports: { db: fakeDb },
    children: [],
    paths: [],
  } as unknown as NodeJS.Require['cache'][string];
}

const savedBufferKey = process.env.BUFFER_API_KEY;

after(() => {
  if (savedVaultKey === undefined) delete process.env.VAULT_ENCRYPTION_KEY;
  else process.env.VAULT_ENCRYPTION_KEY = savedVaultKey;
  if (savedBufferKey === undefined) delete process.env.BUFFER_API_KEY;
  else process.env.BUFFER_API_KEY = savedBufferKey;
});

type VaultCredentialsModule = typeof import('../vault-credentials');
type VaultEncryptionModule = typeof import('@tourbillon/shared/vault-encryption');
const { encryptCredential } = require_('@tourbillon/shared/vault-encryption') as VaultEncryptionModule;

/** api_key row (authType !== 'oauth' keeps the refresh paths out of these pins). */
function credRow(id: string, scope: string, secret: string, owner: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, scope, authType: 'api_key', needsReauth: false, encryptedValue: encryptCredential(secret), ...owner };
}

beforeEach(() => {
  queries.length = 0;
  vaultRows = {};
});

describe('vault-credentials', () => {
  before(() => {
    process.env.VAULT_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  describe('resolveVaultSecret', () => {
    const resolve = (...args: Parameters<VaultCredentialsModule['resolveVaultSecret']>) =>
      (require_('../vault-credentials') as VaultCredentialsModule).resolveVaultSecret(...args);

    it('should have correct resolution order', async () => {
      // AC-V2.1: agent (if agentId) -> company_user (if userId) -> company -> legacy -> env -> null.
      // Rows exist at ALL scopes; the first hit must short-circuit the later probes.
      const ctx = { companyId: 'c1', serverId: 'srv', agentId: 'a1', userId: 'u1' };
      vaultRows = {
        agent: credRow('r-agent', 'agent', 'agent-secret', { agentId: 'a1' }),
        company_user: credRow('r-user', 'company_user', 'user-secret', { userId: 'u1' }),
        company: credRow('r-co', 'company', 'company-secret'),
      };
      assert.equal(await resolve(ctx), 'agent-secret');
      assert.deepEqual(queries, [{ companyId: 'c1', serverId: 'srv', scope: 'agent', agentId: 'a1' }]);

      // No agent credential -> company_user is next, and its probe is the user-scoped one.
      queries.length = 0;
      delete vaultRows.agent;
      assert.equal(await resolve(ctx), 'user-secret');
      assert.deepEqual(queries.map((q) => q.scope), ['agent', 'company_user']);
      assert.deepEqual(queries[1], { companyId: 'c1', serverId: 'srv', scope: 'company_user', userId: 'u1' });

      // Neither -> company.
      queries.length = 0;
      delete vaultRows.company_user;
      assert.equal(await resolve(ctx), 'company-secret');
      assert.deepEqual(queries.map((q) => q.scope), ['agent', 'company_user', 'company']);
      assert.deepEqual(queries[2], { companyId: 'c1', serverId: 'srv', scope: 'company' });
    });

    it('should enforce scope semantics (AC-V2.2)', async () => {
      // company scope: any caller in the company reads it — exactly one probe,
      // scope 'company', and NO owner-column filters in its WHERE.
      vaultRows = { company: credRow('r-co', 'company', 'company-secret') };
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv' }), 'company-secret');
      assert.deepEqual(queries, [{ companyId: 'c1', serverId: 'srv', scope: 'company' }]);

      // company_user scope: only the matching userId reads it.
      queries.length = 0;
      vaultRows = { company_user: credRow('r-user', 'company_user', 'user-secret', { userId: 'u1' }) };
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv', userId: 'u1' }), 'user-secret');
      assert.deepEqual(queries[0], { companyId: 'c1', serverId: 'srv', scope: 'company_user', userId: 'u1' });
      queries.length = 0;
      // A different user must NOT see it: the user probe filters the foreign userId
      // (fake hides the row), and no company row exists -> null.
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv', userId: 'u2' }), null);
      assert.deepEqual(queries.map((q) => q.scope), ['company_user', 'company']);

      // agent scope: only the matching agentId reads it.
      queries.length = 0;
      vaultRows = { agent: credRow('r-agent', 'agent', 'agent-secret', { agentId: 'a1' }) };
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv', agentId: 'a2' }), null);
      assert.deepEqual(queries[0], { companyId: 'c1', serverId: 'srv', scope: 'agent', agentId: 'a2' });
      queries.length = 0;
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv', agentId: 'a1' }), 'agent-secret');
      assert.deepEqual(queries[0], { companyId: 'c1', serverId: 'srv', scope: 'agent', agentId: 'a1' });
    });

    it('skips a needsReauth row and falls through to the next scope', async () => {
      vaultRows = {
        agent: credRow('r-agent', 'agent', 'agent-secret', { agentId: 'a1', needsReauth: true }),
        company: credRow('r-co', 'company', 'company-secret'),
      };
      assert.equal(await resolve({ companyId: 'c1', serverId: 'srv', agentId: 'a1' }), 'company-secret');
      assert.deepEqual(queries.map((q) => q.scope), ['agent', 'company']);
    });

    it('falls back to legacy settings then env when no vault row exists (AC-V2.1 steps 4-6)', async () => {
      // 'buffer-mcp' is a builtin server definition WITH auth (envVar BUFFER_API_KEY),
      // which is what lets resolveMcpCredential answer at all.
      const ctx = { companyId: 'c1', serverId: 'buffer-mcp' };
      process.env.BUFFER_API_KEY = ' env-key ';
      try {
        // agentRuntime legacy wins over company settings and env.
        assert.equal(
          await resolve({
            ...ctx,
            agentRuntime: { mcpCredentials: { 'buffer-mcp': ' agent-legacy ' } } as never,
            companySettings: { mcpCredentials: { 'buffer-mcp': 'company-legacy' } } as never,
          }),
          'agent-legacy',
        );
        // company legacy wins over env.
        assert.equal(
          await resolve({ ...ctx, companySettings: { mcpCredentials: { 'buffer-mcp': 'company-legacy' } } as never }),
          'company-legacy',
        );
        // env fallback, trimmed.
        assert.equal(await resolve(ctx), 'env-key');
        // nothing anywhere -> null.
        delete process.env.BUFFER_API_KEY;
        assert.equal(await resolve(ctx), null);
      } finally {
        if (savedBufferKey === undefined) delete process.env.BUFFER_API_KEY;
        else process.env.BUFFER_API_KEY = savedBufferKey;
      }
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
    it('is supported in API per PM decision #3', async () => {
      const { getVaultCredentialStatus } = require_('../vault-credentials');
      // A real company_user status read: the probe must carry scope AND userId, and
      // only the row owned by that user answers it.
      vaultRows = { company_user: credRow('r-user', 'company_user', 'user-secret', { userId: 'u1' }) };
      assert.deepEqual(await getVaultCredentialStatus('c1', 'srv', 'company_user', 'u1'), {
        configured: true,
        needsReauth: false,
      });
      assert.deepEqual(queries.at(-1), { companyId: 'c1', serverId: 'srv', scope: 'company_user', userId: 'u1' });

      // A foreign userId probes with its own filter and finds nothing.
      queries.length = 0;
      assert.deepEqual(await getVaultCredentialStatus('c1', 'srv', 'company_user', 'u2'), {
        configured: false,
        needsReauth: false,
      });
      assert.deepEqual(queries.at(-1), { companyId: 'c1', serverId: 'srv', scope: 'company_user', userId: 'u2' });

      // needsReauth on the stored row is reported, not swallowed.
      queries.length = 0;
      vaultRows = { company_user: credRow('r-user', 'company_user', 'user-secret', { userId: 'u1', needsReauth: true }) };
      assert.deepEqual(await getVaultCredentialStatus('c1', 'srv', 'company_user', 'u1'), {
        configured: true,
        needsReauth: true,
      });
    });
  });
});
