/**
 * UX-2: setAgentActiveAction (status chip on the agent detail page).
 * Real lib/company.ts + lib/board-auth.ts (board session cookie, agent-token refusal);
 * next/headers, @tourbillon/db, @tourbillon/shared and @/lib/agents are mocked via
 * Module.prototype.require (same approach as lib/board-gate.test.ts). All values are fakes.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';

const BOARD_SECRET = 'test-operator-secret-ux2';
const SESSION_COOKIE = 'tourbillon_board_session';
const AGENT_RUN_TOKEN = `pm_run_${Buffer.from(
  JSON.stringify({ runId: 'r1', agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;
const AGENT_CHAT_TOKEN = `pm_chat_${Buffer.from(
  JSON.stringify({ agentId: 'agent-1', companyId: 'company-a', iat: 1 }),
).toString('base64url')}`;

function sessionKey(secret: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', 'tourbillon-board-session-v1').update(secret).digest());
}
async function sessionToken(secret = BOARD_SECRET) {
  return new SignJWT({ typ: 'tourbillon_board_session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(sessionKey(secret));
}

type MockAgent = { id: string; status: string; runtimeConfig: { heartbeat: { enabled: boolean } } };
const reqState: { cookies: Record<string, string>; headers: Record<string, string> } = { cookies: {}, headers: {} };
let agentsById: Map<string, MockAgent>;
let setCalls: Array<[string, boolean]>;
let failNext: Error | null;
let revalidated: string[];

describe('UX-2 setAgentActiveAction', () => {
  let action: typeof import('./actions').setAgentActiveAction;
  let AgentValidationError: new (m: string) => Error;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    class MockAgentValidationError extends Error {}
    AgentValidationError = MockAgentValidationError;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === 'next/headers') {
        return {
          cookies: async () => ({
            get: (name: string) => (name in reqState.cookies ? { name, value: reqState.cookies[name] } : undefined),
            set: () => {},
            delete: () => {},
          }),
          headers: async () => new Headers(reqState.headers),
        };
      }
      if (id === 'next/cache') return { revalidatePath: (p: string) => revalidated.push(p) };
      if (id === 'next/navigation') {
        return { redirect: (url: string) => { throw new Error(`redirect:${url}`); } };
      }
      if (id === '@tourbillon/db') return { companies: {}, db: { query: { companies: { findFirst: async () => null } } } };
      if (id === '@tourbillon/shared') {
        return { ensureCompanyWorkspace: async () => {}, mergeCompanySettings: (a: unknown) => a, parseCompanySettings: (a: unknown) => a };
      }
      if (id === 'drizzle-orm') return { eq: () => ({}), asc: (c: unknown) => c };
      if (id === '@/lib/agents') {
        return {
          AgentValidationError: MockAgentValidationError,
          // Mirrors lib/agents.ts setAgentActive: status only (active ↔ paused).
          setAgentActive: async (agentId: string, active: boolean) => {
            setCalls.push([agentId, active]);
            if (failNext) throw failNext;
            const agent = agentsById.get(agentId);
            if (!agent) throw new MockAgentValidationError('Agent not found.');
            agent.status = active ? 'active' : 'paused';
            return { ...agent };
          },
          deleteAgent: async () => {},
          updateAgentRole: async () => {},
        };
      }
      if (id === '@/lib/heartbeat') return { triggerAgentHeartbeat: async () => ({}), retryFailedHeartbeat: async () => ({}) };
      if (id === '@/lib/heartbeats') return { getHeartbeatRun: async () => null, getInFlightHeartbeatRun: async () => null };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ setAgentActiveAction: action } = await import('./actions'));
  });

  beforeEach(async () => {
    process.env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    delete process.env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-not-default';
    reqState.cookies = { [SESSION_COOKIE]: await sessionToken() };
    reqState.headers = {};
    agentsById = new Map([
      ['agent-on', { id: 'agent-on', status: 'active', runtimeConfig: { heartbeat: { enabled: false } } }],
      ['agent-off', { id: 'agent-off', status: 'paused', runtimeConfig: { heartbeat: { enabled: true } } }],
    ]);
    setCalls = [];
    failNext = null;
    revalidated = [];
  });

  it('board session: Active → inactive (status paused)', async () => {
    const res = await action('agent-on', false, 'on');
    assert.deepEqual(res, { ok: true, active: false, status: 'paused' });
    assert.deepEqual(setCalls, [['agent-on', false]]);
    assert.equal(agentsById.get('agent-on')!.status, 'paused');
    assert.deepEqual(revalidated, ['/agent', '/agent/on']);
  });

  it('board session: Inactive → active', async () => {
    const res = await action('agent-off', true, 'off');
    assert.deepEqual(res, { ok: true, active: true, status: 'active' });
    assert.equal(agentsById.get('agent-off')!.status, 'active');
  });

  it('heartbeat timer setting is untouched in both directions', async () => {
    await action('agent-on', false);
    await action('agent-off', true);
    assert.equal(agentsById.get('agent-on')!.runtimeConfig.heartbeat.enabled, false);
    assert.equal(agentsById.get('agent-off')!.runtimeConfig.heartbeat.enabled, true);
  });

  it('no board session → refused before any write', async () => {
    reqState.cookies = {};
    await assert.rejects(() => action('agent-on', false), { name: 'BoardSessionRequiredError' });
    reqState.cookies = { [SESSION_COOKIE]: await sessionToken('attacker-guess') };
    await assert.rejects(() => action('agent-on', false), { name: 'BoardSessionRequiredError' });
    assert.deepEqual(setCalls, []);
    assert.equal(agentsById.get('agent-on')!.status, 'active');
  });

  it('agent run/chat bearer (even with a valid board session) → refused before any write', async () => {
    for (const token of [AGENT_RUN_TOKEN, AGENT_CHAT_TOKEN]) {
      reqState.headers = { authorization: `Bearer ${token}` };
      await assert.rejects(() => action('agent-on', false), { name: 'BoardSessionRequiredError' });
    }
    assert.deepEqual(setCalls, []);
    assert.equal(agentsById.get('agent-on')!.status, 'active');
  });

  it('server error → { ok: false, 500 } with a generic message (no internals)', async () => {
    failNext = new Error('db exploded: connection string postgres://x');
    const res = await action('agent-on', false);
    assert.deepEqual(res, { ok: false, status: 500, error: 'Failed to update agent status.' });
  });

  it('validation error (e.g. pending approval) → { ok: false, 400 } with its message', async () => {
    failNext = new AgentValidationError('Agent is pending approval and cannot be activated yet.');
    const res = await action('agent-on', true);
    assert.deepEqual(res, { ok: false, status: 400, error: 'Agent is pending approval and cannot be activated yet.' });
  });

  it('missing agent id → 400, no write', async () => {
    const res = await action('', true);
    assert.equal(res.ok, false);
    assert.deepEqual(setCalls, []);
  });
});
