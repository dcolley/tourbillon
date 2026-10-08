/**
 * Title validation on REST create and mobile profile PATCH.
 * Real createAgent / updateAgentProfile; auth and unrelated deps mocked.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

const JWT_SECRET = 'test-better-auth-secret-title-surfaces';
process.env.BETTER_AUTH_SECRET = JWT_SECRET;
process.env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-title-surfaces';
delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;

type Row = Record<string, unknown> & {
  id: string;
  companyId: string;
  urlKey: string;
  name: string;
  title: string;
  status: string;
  role?: string;
  adapterType?: string;
  modelId?: string | null;
  providerId?: string | null;
  reportsToId?: string | null;
  assignedSkills?: unknown[];
  assignedToolsets?: unknown[];
  mcpServerIds?: unknown[];
  budgetMonthlyTokens?: number;
  spentMonthlyTokens?: number;
  runtimeConfig?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
};

/** PM's added invisible set (B1), beyond `\s` + U+200B–200D/U+2060/U+FEFF. */
const NEW_INVISIBLES = [
  '\u00AD', '\u180E', '\u200E', '\u200F',
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  '\u2066', '\u2067', '\u2068', '\u2069',
  '\u3164', '\u2800', '\u061C', '\u115F', '\uFFA0', '\u034F',
];

let agentRow: Row;
let inserts: Array<Record<string, unknown>>;
let setPayloads: Array<Record<string, unknown>>;
let nextAgentFind: Row | null;
const company = {
  id: 'company-a',
  name: 'Company A',
  allowedMcpServerIds: [] as string[],
  settings: {},
};

function agentFixture(): Row {
  return {
    id: 'agent-1',
    companyId: 'company-a',
    urlKey: 'alice',
    name: 'Alice',
    title: 'CEO',
    status: 'active',
    role: 'ceo',
    adapterType: 'lmstudio',
    modelId: 'model-1',
    providerId: null,
    reportsToId: null,
    assignedSkills: [],
    assignedToolsets: [],
    mcpServerIds: [],
    budgetMonthlyTokens: 0,
    spentMonthlyTokens: 0,
    runtimeConfig: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('agent title validation surfaces (REST + mobile)', () => {
  let restPOST: (req: NextRequest, ctx: { params: Promise<{ companyId: string }> }) => Promise<Response>;
  let mobilePATCH: (req: NextRequest, ctx: { params: Promise<{ urlKey: string }> }) => Promise<Response>;
  let boardJwt: string;
  let AGENT_TITLE_MAX_CHARS: number;

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
      './chat',
    ]);
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      const fromAgents = this.filename?.endsWith('/lib/agents.ts');
      if (id === '@tourbillon/db') {
        return {
          agents: {
            id: 'id',
            companyId: 'companyId',
            urlKey: 'urlKey',
            name: 'name',
            title: 'title',
            role: 'role',
            status: 'status',
            reportsToId: 'reportsToId',
          },
          companies: { id: 'id' },
          activityLog: {},
          approvals: {},
          issues: {},
          db: {
            query: {
              agents: { findFirst: async () => nextAgentFind },
              companies: { findFirst: async () => company },
            },
            select: () => ({
              from: () => ({
                where: () => Promise.resolve([{ id: 'agent-1', name: 'Alice', urlKey: 'alice', role: 'ceo' }]),
              }),
            }),
            insert: () => ({
              values: (payload: Record<string, unknown>) => {
                inserts.push(payload);
                return {
                  returning: async () => [
                    {
                      ...agentFixture(),
                      id: 'agent-new',
                      ...payload,
                    } as Row,
                  ],
                };
              },
            }),
            update: () => ({
              set: (payload: Record<string, unknown>) => {
                setPayloads.push(payload);
                return {
                  where: () => ({
                    returning: async () => {
                      agentRow = { ...agentRow, ...payload } as Row;
                      nextAgentFind = agentRow;
                      return [agentRow];
                    },
                  }),
                };
              },
            }),
          },
        };
      }
      if (id === 'drizzle-orm') {
        return {
          eq: () => ({}),
          and: () => ({}),
          desc: () => ({}),
          inArray: () => ({}),
        };
      }
      if (STUBBED.has(id)) {
        return new Proxy({}, { get: (_t, k) => (k === '__esModule' ? true : async () => null) });
      }
      if (id === '@/lib/auth/agent-token-auth' || id.endsWith('/auth/agent-token-auth')) {
        return {
          authenticateAgentToken: async () => ({
            kind: 'run',
            agentId: 'agent-1',
            companyId: 'company-a',
            runId: 'run-1',
          }),
        };
      }
      if (id === '@/lib/llm-providers' || id === './llm-providers') {
        return {
          listLlmProvidersPublic: async () => [
            { id: 'provider-1', name: 'LM Studio', type: 'lmstudio', isDefault: true },
          ],
          getDefaultLlmProviderRecord: async () => null,
        };
      }
      if (id === './company' && fromAgents) {
        return { getActiveCompany: async () => company };
      }
      if (id === '@tourbillon/shared/company-workspace' && fromAgents) {
        return {
          seedAgentSkillsFromTemplates: async () => {},
          buildAssignedSkills: async () => [],
          copyAgentWorkspaceSkills: async () => {},
          discoverCompanySkillSlugs: async () => [],
        };
      }
      if (id === './code-execution-config' && fromAgents) {
        return {
          applyCodeExecutionOverrides: () => ({}),
          buildCodeExecutionActivityDetails: () => ({}),
        };
      }
      if (id === '@tourbillon/shared' && this.filename?.endsWith('/lib/company.ts')) {
        return {
          ensureCompanyWorkspace: async () => {},
          mergeCompanySettings: (a: unknown) => a,
          parseCompanySettings: (a: unknown) => a,
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    ({ POST: restPOST } = (await import('./companies/[companyId]/agents/route')) as never);
    ({ PATCH: mobilePATCH } = (await import('./mobile/agents/[urlKey]/route')) as never);
    ({ AGENT_TITLE_MAX_CHARS } = await import('../../lib/agents'));
    boardJwt = await new SignJWT({ companyId: 'company-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  });

  beforeEach(() => {
    agentRow = agentFixture();
    nextAgentFind = agentRow;
    inserts = [];
    setPayloads = [];
  });

  async function restCreate(body: unknown) {
    const res = await restPOST(
      new NextRequest('http://localhost/api/companies/company-a/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer pm_run_test',
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ companyId: 'company-a' }) },
    );
    return { status: res.status, body: (await res.json()) as { error?: string; title?: string } };
  }

  async function mobileProfile(body: Record<string, unknown>) {
    const res = await mobilePATCH(
      new NextRequest('http://localhost/api/mobile/agents/alice', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-company-token': boardJwt,
        },
        body: JSON.stringify({ section: 'profile', name: 'Alice', urlKey: 'alice', ...body }),
      }),
      { params: Promise.resolve({ urlKey: 'alice' }) },
    );
    return {
      status: res.status,
      body: (await res.json()) as { error?: string; agent?: { title: string } },
    };
  }

  describe('REST POST /api/companies/[companyId]/agents', () => {
    it('non-string title → 400 (null = missing → Title is required)', async () => {
      nextAgentFind = null;
      for (const title of [42, true, { t: 1 }, ['CEO'], null]) {
        const expected = title === null ? 'Title is required.' : 'Title must be a string.';
        const res = await restCreate({ name: 'Bob', title, role: 'engineer', urlKey: `bob-${typeof title}` });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, expected);
      }
      assert.equal(inserts.length, 0);
    });

    it('over 200 → 400; exactly 200 + trimmed → 201', async () => {
      nextAgentFind = null;
      const over = await restCreate({
        name: 'Bob',
        title: 'z'.repeat(201),
        role: 'engineer',
        urlKey: 'bob-long',
      });
      assert.equal(over.status, 400);
      assert.equal(over.body.error, 'Title must be at most 200 characters.');
      assert.equal(inserts.length, 0);

      const title200 = 'a'.repeat(AGENT_TITLE_MAX_CHARS);
      const ok = await restCreate({
        name: 'Bob',
        title: `  ${title200}  `,
        role: 'engineer',
        urlKey: 'bob-ok',
      });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.title, title200);
      assert.equal(inserts.length, 1);
    });

    it('empty / zero-width-only title → 400 Title is required', async () => {
      nextAgentFind = null;
      for (const title of ['   ', '​', '​‌﻿']) {
        inserts = [];
        const res = await restCreate({
          name: 'Bob',
          title,
          role: 'engineer',
          urlKey: `bob-empty-${title.length}`,
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Title is required.');
        assert.equal(inserts.length, 0);
      }
    });
  });

  describe('REST POST — B1 invisible set', () => {
    it('title made only of the new invisibles (or with spaces) → 400 Title is required', async () => {
      nextAgentFind = null;
      const cases = [...NEW_INVISIBLES, ...NEW_INVISIBLES.map((c) => `  ${c}\t${c} `), NEW_INVISIBLES.join(' ')];
      for (const [i, title] of cases.entries()) {
        const res = await restCreate({ name: 'Bob', title, role: 'engineer', urlKey: `bob-inv-${i}` });
        assert.equal(res.status, 400, JSON.stringify(title));
        assert.equal(res.body.error, 'Title is required.');
      }
      assert.equal(inserts.length, 0);
    });

    it('new invisibles are trimmed from the edges; U+200B in the middle is kept', async () => {
      nextAgentFind = null;
      const res = await restCreate({
        name: 'Bob',
        title: '\u202E\u2066 Chief\u200BOfficer \u2069\u00AD\u3164',
        role: 'engineer',
        urlKey: 'bob-edges',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.title, 'Chief\u200BOfficer');
      assert.equal(inserts[0].title, 'Chief\u200BOfficer');
    });
  });

  describe('mobile PATCH profile', () => {
    it('B1: title made only of the new invisibles keeps the current title (D2), never replaces it', async () => {
      for (const ch of NEW_INVISIBLES) {
        for (const title of [ch, ` ${ch} ${ch} `]) {
          agentRow = agentFixture();
          nextAgentFind = agentRow;
          setPayloads = [];
          const res = await mobileProfile({ title });
          assert.equal(res.status, 200, JSON.stringify(title));
          assert.equal(res.body.agent?.title, 'CEO');
          assert.equal(setPayloads[0].title, 'CEO');
        }
      }
    });

    it('S3: stored 250×L, send 250×M → 400', async () => {
      agentRow = { ...agentFixture(), title: 'L'.repeat(250) };
      nextAgentFind = agentRow;
      const res = await mobileProfile({ title: 'M'.repeat(250) });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Title must be at most 200 characters.');
      assert.equal(setPayloads.length, 0);
    });

    it('stored title with edge blanks is compared trimmed; a different real title replaces it', async () => {
      const stored = `\u200E ${'L'.repeat(250)} \uFEFF`;
      agentRow = { ...agentFixture(), title: stored };
      nextAgentFind = agentRow;
      const same = await mobileProfile({ title: 'L'.repeat(250) });
      assert.equal(same.status, 200);
      assert.equal(setPayloads[0].title, stored);

      setPayloads = [];
      agentRow = { ...agentFixture(), title: ' \u200BCEO\u2069 ' };
      nextAgentFind = agentRow;
      const changed = await mobileProfile({ title: ' Chief\u200BOfficer\u00AD' });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.agent?.title, 'Chief\u200BOfficer');
      assert.equal(setPayloads[0].title, 'Chief\u200BOfficer');
    });

    it('S2: name-only save passes when the stored title is legacy blank / zero-width / invisible', async () => {
      for (const stored of ['', '   ', '\u200B', '\u200B\uFEFF', '\u3164', ' \u2800\u202A ']) {
        for (const body of [{}, { title: null }, { title: '' }, { title: '\u200B' }, { title: stored }]) {
          agentRow = { ...agentFixture(), title: stored };
          nextAgentFind = agentRow;
          setPayloads = [];
          const res = await mobileProfile({ name: 'Alice Renamed', ...body });
          assert.equal(res.status, 200, JSON.stringify([stored, body, res.body]));
          assert.equal(setPayloads[0].title, stored);
          assert.equal(setPayloads[0].name, 'Alice Renamed');
        }
      }
    });

    it('non-string title → 400 (no coercion / no keep-current)', async () => {
      for (const title of [42, true, { t: 1 }, ['CTO']]) {
        nextAgentFind = agentRow;
        const res = await mobileProfile({ title });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Title must be a string.');
      }
      assert.equal(setPayloads.length, 0);
    });

    it('over 200 → 400; exactly 200 + trimmed → 200', async () => {
      const over = await mobileProfile({ title: 'q'.repeat(201) });
      assert.equal(over.status, 400);
      assert.equal(over.body.error, 'Title must be at most 200 characters.');
      assert.equal(setPayloads.length, 0);

      const title200 = 'b'.repeat(AGENT_TITLE_MAX_CHARS);
      const ok = await mobileProfile({ title: ` \n${title200}\t ` });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.agent?.title, title200);
      assert.equal(setPayloads.length, 1);
      assert.equal(setPayloads[0].title, title200);
    });

    it('omitted / null / blank / zero-width-only title keeps the current title (no wipe)', async () => {
      for (const body of [{}, { title: null }, { title: '' }, { title: '   ' }, { title: '​‌﻿' }]) {
        agentRow = agentFixture();
        nextAgentFind = agentRow;
        setPayloads = [];
        const res = await mobileProfile(body);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(res.body.agent?.title, 'CEO');
        assert.equal(setPayloads.length, 1);
        assert.equal(setPayloads[0].title, 'CEO');
      }
    });

    it('S3: mobile name-only save keeps a legacy over-cap title', async () => {
      const legacy = 'L'.repeat(AGENT_TITLE_MAX_CHARS + 40);
      agentRow = { ...agentFixture(), title: legacy };
      nextAgentFind = agentRow;
      // Omitted title → keep current (over-cap) without re-applying the 200 cap.
      const res = await mobileProfile({ name: 'Alice Renamed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.agent?.title, legacy);
      assert.equal(setPayloads.length, 1);
      assert.equal(setPayloads[0].title, legacy);
      assert.equal(setPayloads[0].name, 'Alice Renamed');
    });
  });

});
