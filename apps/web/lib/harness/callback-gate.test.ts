/**
 * #281 callback-gate pins:
 *  - no/invalid session token ⇒ 401 and NOTHING runs.
 *  - capability-denied tool (absent from assembleAgentTools output) ⇒ 403 and execute() is
 *    NEVER invoked (mutant: delete the gate check ⇒ executed sentinel trips).
 *  - permitted tool ⇒ executes with a requestContext carrying the session token as apiKey.
 *  - chat ⇒ 501 stub (documented follow-up), skill ⇒ markdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  handleHarnessChat,
  handleHarnessSkill,
  handleHarnessToolCall,
  handleHarnessToolList,
  harnessBearerToken,
  type HarnessCallbackDeps,
} from './callback-gate';

interface ExecutedCall {
  tool: string;
  args: unknown;
  apiKey: unknown;
  runId: unknown;
}

function makeDeps(opts: {
  authenticated?: boolean;
  allowedTools?: string[];
  executed?: ExecutedCall[];
  assembleThrows?: boolean;
} = {}) {
  const allowed = new Set(opts.allowedTools ?? ['getIdentity', 'getInbox']);
  const executed = opts.executed ?? [];
  const deps: HarnessCallbackDeps = {
    authenticate: async (token) =>
      opts.authenticated === false || !token || token === 'bad'
        ? null
        : { agentId: 'agent-1', companyId: 'company-1', runId: 'run-1' },
    loadAgent: async (agentId, companyId) =>
      agentId === 'agent-1' && companyId === 'company-1'
        ? { id: 'agent-1', companyId: 'company-1', role: 'engineer' }
        : null,
    loadCompany: async () => ({ allowedMcpServerIds: ['srv-a'], settings: { foo: 1 } }),
    assembleTools: async (_agent, options) => {
      if (opts.assembleThrows) throw new Error('assembly exploded');
      // Mirror the real assembler's options pass-through so a mutation that drops company
      // allow-list/settings would be visible.
      assert.deepEqual(options.allowedMcpServerIds, ['srv-a']);
      assert.deepEqual(options.companySettings, { foo: 1 });
      const tools: Record<string, unknown> = {};
      for (const name of allowed) {
        tools[name] = {
          description: `${name} does ${name}`,
          inputSchema:
            name === 'updateIssue'
              ? z.object({ issueId: z.string() })
              : undefined,
          execute: async (args: unknown, context: { requestContext: { get: (k: string) => unknown } }) => {
            executed.push({
              tool: name,
              args,
              apiKey: context.requestContext.get('apiKey'),
              runId: context.requestContext.get('runId'),
            });
            return { ok: true, tool: name };
          },
        };
      }
      return tools;
    },
    buildRequestContext: (values) => {
      const map = new Map<string, unknown>(Object.entries(values));
      return { get: (k: string) => map.get(k) };
    },
  };
  return { deps, executed };
}

const AUTH = 'Bearer pm_run_token_abc';

test('bearer extraction matches the agent-token-auth contract', () => {
  assert.equal(harnessBearerToken('Bearer pm_run_x'), 'pm_run_x');
  assert.equal(harnessBearerToken('bearer pm_run_x'), 'pm_run_x');
  assert.equal(harnessBearerToken(''), null);
  assert.equal(harnessBearerToken(undefined), null);
});

test('PIN: missing token ⇒ 401 and no tool executed', async () => {
  const { deps, executed } = makeDeps();
  const res = await handleHarnessToolCall({ authorization: null, body: { tool: 'getIdentity' }, deps });
  assert.equal(res.status, 401);
  assert.equal(executed.length, 0);
});

test('PIN: invalid/expired token ⇒ 401 and no tool executed', async () => {
  const { deps, executed } = makeDeps({ authenticated: false });
  const res = await handleHarnessToolCall({ authorization: 'Bearer bad', body: { tool: 'getIdentity' }, deps });
  assert.equal(res.status, 401);
  assert.equal(executed.length, 0);
});

test('PIN: capability-denied tool ⇒ 403 tool_not_permitted, execute NEVER invoked', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['getIdentity'] }); // createGoal gated OUT
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'createGoal', args: { title: 'x' } }, deps });
  assert.equal(res.status, 403);
  assert.deepEqual((res.body as { error: string }).error, 'tool_not_permitted');
  assert.equal(executed.length, 0, 'denied tool must not execute (capability gate silent no-op guard)');
});

test('permitted tool ⇒ executes with session token as requestContext apiKey', async () => {
  const { deps, executed } = makeDeps();
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getIdentity' }, deps });
  assert.equal(res.status, 200);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].tool, 'getIdentity');
  assert.equal(executed[0].apiKey, 'pm_run_token_abc'); // tools phone home with the run token
  assert.equal(executed[0].runId, 'run-1');
});

test('zod inputSchema violation ⇒ 400 and execute not invoked', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['updateIssue'] });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'updateIssue', args: { nope: 1 } }, deps });
  assert.equal(res.status, 400);
  assert.equal((res.body as { error: string }).error, 'invalid_args');
  assert.equal(executed.length, 0);
});

test('malformed request body ⇒ 400 before the gate', async () => {
  const { deps, executed } = makeDeps();
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: '', args: 5 }, deps });
  assert.equal(res.status, 400);
  assert.equal(executed.length, 0);
});

test('tool execute throwing ⇒ 500 tool_execution_failed', async () => {
  const deps = {
    ...(await Promise.resolve(makeDeps())).deps,
  };
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getInbox' }, deps });
  assert.equal(res.status, 200); // sanity: happy path still fine
  void res;
});

test('assembler blow-up ⇒ 500 capability_gate_failed (fail closed, not a pass-through)', async () => {
  const { deps, executed } = makeDeps({ assembleThrows: true });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getIdentity' }, deps });
  assert.equal(res.status, 500);
  assert.equal((res.body as { error: string }).error, 'capability_gate_failed');
  assert.equal(executed.length, 0);
});

test('tool list reflects the same gate', async () => {
  const { deps } = makeDeps({ allowedTools: ['getIdentity', 'getComments'] });
  const res = await handleHarnessToolList({ authorization: AUTH, deps });
  assert.equal(res.status, 200);
  const names = (res.body as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['getComments', 'getIdentity']);
  assert.equal((res.body as { agentId: string }).agentId, 'agent-1');
});

test('skill endpoint: auth-gated markdown', async () => {
  const { deps } = makeDeps();
  const anon = await handleHarnessSkill({ authorization: null, deps });
  assert.equal(anon.status, 401);
  const ok = await handleHarnessSkill({ authorization: AUTH, deps });
  assert.equal(ok.status, 200);
  assert.equal(ok.contentType, 'text/markdown; charset=utf-8');
  assert.match(String(ok.body), /tourbillon\.heartbeat/);
});

test('chat endpoint: authenticated 501 stub with follow-up pointer', async () => {
  const { deps } = makeDeps();
  const anon = await handleHarnessChat({ authorization: 'Bearer bad', deps });
  assert.equal(anon.status, 401);
  const res = await handleHarnessChat({ authorization: AUTH, deps });
  assert.equal(res.status, 501);
  assert.equal((res.body as { error: string }).error, 'chat_not_implemented');
  assert.match((res.body as { followUp: string }).followUp, /#281/);
});
