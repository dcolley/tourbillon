/**
 * Dashboard updateAgentProfileAction: title validation surfaces as actionError
 * (validation message), never a 500. FormData titles are strings; we also pass
 * non-strings via a forged FormData-like get() for the non-string cases.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const SESSION_COOKIE = 'tourbillon_board_session';
const JWT_SECRET = 'test-better-auth-secret-title';
process.env.BETTER_AUTH_SECRET = JWT_SECRET;
process.env.TOURBILLON_BOARD_SECRET = 'test-operator-secret-title';
delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;

type Row = {
  id: string;
  companyId: string;
  urlKey: string;
  name: string;
  title: string;
  status: string;
  reportsToId: string | null;
};
let agentRow: Row;
let setPayloads: Array<Record<string, unknown>>;
const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = {
  cookies: {},
  headers: {},
};

function formWith(fields: Record<string, unknown>): FormData {
  const fd = new FormData();
  // FormData.set only accepts string|Blob. For non-string title tests we override get.
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') fd.set(k, v);
  }
  if ('title' in fields && typeof fields.title !== 'string') {
    const rawGet = fd.get.bind(fd);
    fd.get = (name: string) => {
      if (name === 'title') return fields.title as never;
      return rawGet(name);
    };
  }
  return fd;
}

describe('dashboard updateAgentProfileAction title validation', () => {
  let action: typeof import('./actions').updateAgentProfileAction;
  let createBoardSessionToken: typeof import('../../../lib/board-auth').createBoardSessionToken;
  let AGENT_TITLE_MAX_CHARS: number;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === 'next/headers') {
        return {
          cookies: async () => ({
            get: (n: string) =>
              n in reqState.cookies ? { name: n, value: reqState.cookies[n] } : undefined,
            set: () => {},
            delete: () => {},
          }),
          headers: async () => new Headers(reqState.headers),
        };
      }
      if (id === 'next/cache') return { revalidatePath: () => {} };
      if (id === 'next/navigation') {
        return {
          redirect: (url: string) => {
            throw new Error(`redirect:${url}`);
          },
        };
      }
      if (id === '@tourbillon/db') {
        // Used by board-auth / company and by real updateAgentProfile.
        const fromAgents = this.filename?.endsWith('/lib/agents.ts');
        if (fromAgents) {
          return {
            agents: { id: 'id', companyId: 'companyId', urlKey: 'urlKey' },
            companies: {},
            activityLog: {},
            db: {
              query: {
                agents: { findFirst: async () => agentRow },
              },
              update: () => ({
                set: (payload: Record<string, unknown>) => {
                  setPayloads.push(payload);
                  return {
                    where: () => ({
                      returning: async () => {
                        agentRow = { ...agentRow, ...payload } as Row;
                        return [agentRow];
                      },
                    }),
                  };
                },
              }),
            },
          };
        }
        return {
          companies: {},
          db: { query: { companies: { findFirst: async () => ({ id: 'company-a', name: 'A' }) } } },
        };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), and: () => ({}), asc: (c: unknown) => c };
      if (id === '@tourbillon/shared') {
        return {
          ensureCompanyWorkspace: async () => {},
          mergeCompanySettings: (a: unknown) => a,
          parseCompanySettings: (a: unknown) => a,
        };
      }
      if (id === '@tourbillon/mastra') return { clearIdleThreadOnRuntimeSwitch: async () => {} };
      if (id === '@/lib/heartbeat' || id === '@/lib/heartbeats') {
        return {
          triggerAgentHeartbeat: async () => ({}),
          retryFailedHeartbeat: async () => ({}),
          getHeartbeatRun: async () => null,
          getInFlightHeartbeatRun: async () => null,
        };
      }
      if (
        (id === './chat' || id === './llm-providers' || id === './company' || id === './code-execution-config') &&
        this.filename?.endsWith('/lib/agents.ts')
      ) {
        return {
          invalidateChatControllerForAgent: () => {},
          getDefaultLlmProviderRecord: async () => null,
          getActiveCompany: async () => ({ id: 'company-a' }),
          applyCodeExecutionOverrides: () => ({}),
          buildCodeExecutionActivityDetails: () => ({}),
        };
      }
      if (id === '@tourbillon/shared/company-workspace' && this.filename?.endsWith('/lib/agents.ts')) {
        return {
          seedAgentSkillsFromTemplates: async () => {},
          buildAssignedSkills: async () => [],
          copyAgentWorkspaceSkills: async () => {},
          discoverCompanySkillSlugs: async () => [],
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };

    ({ updateAgentProfileAction: action } = await import('./actions'));
    ({ createBoardSessionToken } = await import('../../../lib/board-auth'));
    ({ AGENT_TITLE_MAX_CHARS } = await import('../../../lib/agents'));
  });

  beforeEach(async () => {
    agentRow = {
      id: 'agent-1',
      companyId: 'company-a',
      urlKey: 'alice',
      name: 'Alice',
      title: 'CEO',
      status: 'active',
      reportsToId: null,
    };
    setPayloads = [];
    reqState.headers = {};
    reqState.cookies = { [SESSION_COOKIE]: (await createBoardSessionToken())! };
  });

  it('non-string title → validation error, no write', async () => {
    for (const title of [42, true, { a: 1 }, ['x'], null]) {
      const expected = title === null ? 'Title is required.' : 'Title must be a string.';
      const res = await action(
        null,
        formWith({
          agentId: 'agent-1',
          currentUrlKey: 'alice',
          name: 'Alice',
          title,
          urlKey: 'alice',
          reportsToId: '',
        }),
      );
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error, expected);
    }
    assert.equal(setPayloads.length, 0);
  });

  it('over 200 → validation error; exactly 200 and trimmed → success', async () => {
    const over = await action(
      null,
      formWith({
        agentId: 'agent-1',
        currentUrlKey: 'alice',
        name: 'Alice',
        title: 'x'.repeat(201),
        urlKey: 'alice',
        reportsToId: '',
      }),
    );
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.error, 'Title must be at most 200 characters.');
    assert.equal(setPayloads.length, 0);

    const title200 = 'y'.repeat(AGENT_TITLE_MAX_CHARS);
    const ok = await action(
      null,
      formWith({
        agentId: 'agent-1',
        currentUrlKey: 'alice',
        name: 'Alice',
        title: `  ${title200}  `,
        urlKey: 'alice',
        reportsToId: '',
      }),
    );
    assert.equal(ok.ok, true);
    assert.equal(setPayloads.length, 1);
    assert.equal(setPayloads[0].title, title200);
  });

  it('empty / zero-width-only title → Title is required', async () => {
    for (const title of ['   ', '​‌', ' ﻿ ']) {
      setPayloads = [];
      const res = await action(
        null,
        formWith({
          agentId: 'agent-1',
          currentUrlKey: 'alice',
          name: 'Alice',
          title,
          urlKey: 'alice',
          reportsToId: '',
        }),
      );
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error, 'Title is required.');
      assert.equal(setPayloads.length, 0);
    }
  });

  it('S3: unchanged over-cap title does not block a name-only save', async () => {
    const legacy = 'L'.repeat(AGENT_TITLE_MAX_CHARS + 50);
    agentRow = { ...agentRow, title: legacy };
    const res = await action(
      null,
      formWith({
        agentId: 'agent-1',
        currentUrlKey: 'alice',
        name: 'Alice Renamed',
        title: legacy,
        urlKey: 'alice',
        reportsToId: '',
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(setPayloads.length, 1);
    assert.equal(setPayloads[0].title, legacy);
    assert.equal(setPayloads[0].name, 'Alice Renamed');
  });
});
