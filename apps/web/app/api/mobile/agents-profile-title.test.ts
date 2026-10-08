/**
 * #126: mobile PATCH /api/mobile/agents/[urlKey] section 'profile' must never wipe the agent's
 * title. updateAgentProfile requires a title; the mobile route used to omit it (a type error in
 * `next build`, and at runtime every mobile profile save failed with "Title is required.").
 * Omitted or blank title now keeps the current one; a non-blank title is applied.
 *
 * Real route handler, real lib/agents.ts updateAgentProfile and real mobile/board auth, against a
 * small in-memory agents/companies table (@tourbillon/db and drizzle-orm faked). All values fake.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const JWT_SECRET = 'test-better-auth-secret-not-default-126';
process.env.BETTER_AUTH_SECRET = JWT_SECRET;
process.env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-126';
delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;

type Row = Record<string, unknown> & { id: string; companyId: string; urlKey: string; title: string };
let rows: Row[];
let writes: Array<Record<string, unknown>>;
const companyRows = [{ id: 'company-a', name: 'Company A', allowedMcpServerIds: [], settings: {} }];

function agentRow(id: string, urlKey: string, title: string): Row {
  return {
    id,
    urlKey,
    title,
    status: 'active',
    companyId: 'company-a',
    name: `Name ${id}`,
    role: 'engineer',
    adapterType: 'lmstudio',
    modelId: 'model-1',
    providerId: null,
    reportsToId: null,
    assignedSkills: [],
    assignedToolsets: [],
    mcpServerIds: [],
    budgetMonthlyTokens: 0,
    spentMonthlyTokens: 0,
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

type Pred = (row: Record<string, unknown>) => boolean;
const col = (name: string) => ({ __col: name });
const table = (cols: string[]) => Object.fromEntries(cols.map((c) => [c, col(c)]));
const fakeDrizzle = new Proxy(
  {
    eq: (c: { __col: string }, v: unknown): Pred => (r) => r[c.__col] === v,
    and: (...ps: Pred[]): Pred => (r) => ps.every((p) => p(r)),
  } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => () => true) },
);
const fakeDb = {
  agents: table(['id', 'companyId', 'urlKey', 'status', 'reportsToId']),
  companies: table(['id']),
  db: {
    query: {
      agents: { findFirst: async ({ where }: { where: Pred }) => rows.find(where) },
      companies: { findFirst: async ({ where }: { where: Pred }) => companyRows.find(where) },
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: (pred: Pred) => ({
          returning: async () => {
            writes.push(payload);
            const hit = rows.filter(pred);
            hit.forEach((r) => Object.assign(r, payload));
            return hit.map((r) => ({ ...r }));
          },
        }),
      }),
    }),
  },
};
const asyncStub = () => new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : async () => null) });

describe('#126 mobile profile save keeps the agent title', () => {
  let mobilePATCH: (req: NextRequest, ctx: { params: Promise<{ urlKey: string }> }) => Promise<Response>;
  let boardJwt: string;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const STUBBED = new Set([
      '@tourbillon/mastra',
      '@/lib/heartbeats',
      '@/lib/heartbeat',
      '@/lib/observability',
      '@/lib/jobs',
      '@/lib/issues',
      '@/lib/goals',
      '@/lib/projects',
      '@/lib/issue-comments',
      '@/lib/wake-client',
      '@/lib/llm-providers',
      './llm-providers',
      './chat',
    ]);
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') return fakeDb;
      if (id === 'drizzle-orm') return fakeDrizzle;
      if (STUBBED.has(id)) return asyncStub();
      if (id === 'next/headers') {
        return {
          cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
          headers: async () => new Headers(),
        };
      }
      if (id === 'next/cache') return { revalidatePath: () => {} };
      if (id === '@tourbillon/shared' && this.filename?.endsWith('/lib/company.ts')) {
        return { ensureCompanyWorkspace: async () => {}, mergeCompanySettings: (a: unknown) => a, parseCompanySettings: (a: unknown) => a };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ PATCH: mobilePATCH } = (await import('./agents/[urlKey]/route')) as never);
    Module.prototype.require = originalRequire;
    boardJwt = await new SignJWT({ companyId: 'company-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  });

  beforeEach(() => {
    rows = [agentRow('agent-1', 'alice', 'Staff Engineer')];
    writes = [];
  });

  async function patchProfile(body: Record<string, unknown>) {
    const res = await mobilePATCH(
      new NextRequest('http://localhost/api/mobile/agents/alice', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-company-token': boardJwt },
        body: JSON.stringify({ section: 'profile', ...body }),
      }),
      { params: Promise.resolve({ urlKey: 'alice' }) },
    );
    return { status: res.status, body: (await res.json()) as { error?: string; agent?: { title?: string; name?: string } } };
  }

  it('profile save without a title succeeds and keeps the existing title (DB write and response)', async () => {
    const res = await patchProfile({ name: 'Alice Renamed', urlKey: 'alice' });
    assert.equal(res.status, 200, res.body.error ?? '');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].title, 'Staff Engineer');
    assert.equal(writes[0].name, 'Alice Renamed');
    assert.equal(rows[0].title, 'Staff Engineer');
    assert.equal(res.body.agent?.title, 'Staff Engineer');
  });

  it('blank or non-string title also keeps the existing title', async () => {
    for (const title of ['', '   ', null, 42]) {
      const res = await patchProfile({ name: 'Alice', urlKey: 'alice', title });
      assert.equal(res.status, 200, `${JSON.stringify(title)}: ${res.body.error}`);
      assert.equal(rows[0].title, 'Staff Engineer', `title ${JSON.stringify(title)}`);
    }
    assert.ok(writes.every((w) => w.title === 'Staff Engineer'));
  });

  it('a non-blank title is applied (trimmed), same as the dashboard profile form', async () => {
    const res = await patchProfile({ name: 'Alice', urlKey: 'alice', title: '  Principal Engineer ' });
    assert.equal(res.status, 200, res.body.error ?? '');
    assert.equal(rows[0].title, 'Principal Engineer');
    assert.equal(res.body.agent?.title, 'Principal Engineer');
  });

  it('other profile validation is unchanged: blank name → 400, nothing written', async () => {
    const res = await patchProfile({ name: '  ', urlKey: 'alice' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Name is required.');
    assert.deepEqual(writes, []);
    assert.equal(rows[0].title, 'Staff Engineer');
  });
});
