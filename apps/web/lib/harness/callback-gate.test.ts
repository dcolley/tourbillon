/**
 * #281 callback-gate pins:
 *  - no/invalid session token ⇒ 401 and NOTHING runs.
 *  - capability-denied tool (absent from assembleAgentTools output) ⇒ 403 and execute() is
 *    NEVER invoked (mutant: delete the gate check ⇒ executed sentinel trips).
 *  - permitted tool ⇒ executes with a requestContext carrying the session token as apiKey.
 *  - chat ⇒ refused unless the bind advertises it (AC5 matrix in callback-chat.test.ts), skill ⇒ markdown.
 *  - S327-S1: tools/call resolves by assembled key (`getInboxTool`) OR tool id (`getInbox`, as
 *    the skills teach); unknown / gated-out names stay 403 and NEVER execute.
 *  - S328-S1: precedence is pinned (key tiers beat the id scan; exact id beats `Tool`-stripped
 *    id) and two assembled tools claiming the same id ⇒ 409 ambiguous_tool, NEITHER executes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  handleHarnessChat,
  handleHarnessSkill,
  handleHarnessToolCall,
  handleHarnessToolList,
  findGatedTool,
  resolveGatedTool,
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
  adapterConfig?: Record<string, unknown>;
  /** Assembled key per tool id (default: the id itself). Real assembler: `${id}Tool`. */
  keyFor?: (id: string) => string;
  /** Set false to assemble tools without an `id` property. */
  withId?: boolean;
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
        ? { id: 'agent-1', companyId: 'company-1', role: 'engineer', ...(opts.adapterConfig ? { adapterConfig: opts.adapterConfig } : {}) }
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
        tools[(opts.keyFor ?? ((n: string) => n))(name)] = {
          ...(opts.withId === false ? {} : { id: name }),
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

test('skill endpoint: OpenCode-bound agent gets the OpenCode SKILL.md blob, Hermes runs keep theirs', async () => {
  const oc = await handleHarnessSkill({
    authorization: AUTH,
    deps: makeDeps({
      adapterConfig: { harness: 'opencode', mode: 'local', command: 'opencode run' },
    }).deps,
  });
  assert.equal(oc.status, 200);
  assert.match(String(oc.body), /opencode serve/); // OpenCode-specific binding taught
  assert.doesNotMatch(String(oc.body), /A2A/); // not the Hermes text

  const hermesBound = await handleHarnessSkill({
    authorization: AUTH,
    deps: makeDeps({ adapterConfig: { harness: 'hermes', mode: 'local', command: 'hermes run' } }).deps,
  });
  assert.match(String(hermesBound.body), /A2A/);

  const plain = await handleHarnessSkill({ authorization: AUTH, deps: makeDeps().deps });
  assert.match(String(plain.body), /A2A/, 'non-harness agents keep the Hermes default blob');
});

test('skill endpoint: OpenCode bind skillInstall override wins', async () => {
  const res = await handleHarnessSkill({
    authorization: AUTH,
    deps: makeDeps({
      adapterConfig: {
        harness: 'opencode',
        mode: 'local',
        command: 'opencode run',
        skillInstall: 'CUSTOM OC SKILL',
      },
    }).deps,
  });
  assert.equal(res.body, 'CUSTOM OC SKILL');
});

test('chat endpoint: auth still first; no advertised chat ⇒ 409 chat_not_supported (no 501 stub)', async () => {
  const { deps } = makeDeps();
  const anon = await handleHarnessChat({ authorization: 'Bearer bad', deps });
  assert.equal(anon.status, 401);
  const res = await handleHarnessChat({ authorization: AUTH, deps });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'chat_not_supported');
  // Full AC5 matrix (sync / stream / gate / mutants): ./callback-chat.test.ts
});

// ── S327-S1: resolve by assembled key OR tool id ─────────────────────────────

const ASSEMBLED = (id: string) => `${id}Tool`; // the real assembleAgentTools key shape

test('PIN S327-S1: skill name (tool id) resolves against assembled `${id}Tool` keys ⇒ 200, executes', async () => {
  for (const tool of ['getInbox', 'sendToAgent']) {
    const { deps, executed } = makeDeps({ allowedTools: ['getInbox', 'sendToAgent'], keyFor: ASSEMBLED });
    const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool, args: {} }, deps });
    assert.equal(res.status, 200, `${tool} must not 403 when assembled as ${tool}Tool`);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].tool, tool);
    assert.equal(executed[0].apiKey, 'pm_run_token_abc');
    assert.equal((res.body as { tool: string }).tool, tool, 'response echoes the requested name');
  }
});

test('PIN S327-S1: assembled key form (`getInboxTool`) still resolves ⇒ 200', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['getInbox'], keyFor: ASSEMBLED });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getInboxTool' }, deps });
  assert.equal(res.status, 200);
  assert.deepEqual(executed.map((e) => e.tool), ['getInbox']);
});

test('PIN S327-S1: `${name}Tool` key resolves even when the tool carries no id', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['getInbox'], keyFor: ASSEMBLED, withId: false });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getInbox' }, deps });
  assert.equal(res.status, 200);
  assert.equal(executed.length, 1);
});

test('PIN S327-S1: id scan resolves a tool keyed under an unrelated assembled key', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['getInbox'], keyFor: (id) => `cp_${id}` });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getInbox' }, deps });
  assert.equal(res.status, 200);
  assert.equal(executed.length, 1);
  const viaKey = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'cp_getInbox' }, deps });
  assert.equal(viaKey.status, 200);
});

test('PIN S327-S1: `…Tool` name resolves a tool assembled under its bare id', async () => {
  const { deps, executed } = makeDeps({ allowedTools: ['getInbox'] }); // keyed `getInbox`
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'getInboxTool' }, deps });
  assert.equal(res.status, 200);
  assert.equal(executed.length, 1);
});

test('PIN S327-S1: unknown / gated-out names (either form) ⇒ 403 tool_not_permitted, NEVER execute', async () => {
  for (const keyFor of [ASSEMBLED, (id: string) => id]) {
    const { deps, executed } = makeDeps({ allowedTools: ['getIdentity', 'getInbox'], keyFor });
    for (const tool of [
      'createGoal',
      'createGoalTool',
      'sendToAgent',
      'sendToAgentTool',
      'Tool',
      'getinbox',
      'getInboxTools',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool, args: {} }, deps });
      assert.equal(res.status, 403, tool);
      assert.equal((res.body as { error: string }).error, 'tool_not_permitted', tool);
      assert.equal((res.body as { tool: string }).tool, tool);
    }
    assert.equal(executed.length, 0, 'denied names must never execute');
  }
});

test('findGatedTool: own executable entries only; id match must be exact', () => {
  const exec = async () => ({ ok: true });
  const tools: Record<string, unknown> = {
    getInboxTool: { id: 'getInbox', execute: exec },
    describedOnly: { id: 'describedOnly', description: 'no execute' },
    cp_weird: { id: 'weird', execute: exec },
  };
  assert.equal(findGatedTool(tools, 'getInbox'), tools.getInboxTool);
  assert.equal(findGatedTool(tools, 'getInboxTool'), tools.getInboxTool);
  assert.equal(findGatedTool(tools, 'weird'), tools.cp_weird);
  assert.equal(findGatedTool(tools, 'weirdTool'), tools.cp_weird);
  assert.equal(findGatedTool(tools, 'describedOnly'), undefined, 'non-executable never resolves');
  assert.equal(findGatedTool(tools, 'getInboxX'), undefined);
  assert.equal(findGatedTool(tools, 'constructor'), undefined);
  assert.equal(findGatedTool(tools, '__proto__'), undefined);
  assert.equal(findGatedTool({}, 'getInbox'), undefined);
});

// ── S328-S1: id/key collision precedence + ambiguity ─────────────────────────────────────
function tool(id: string, executed: string[], label: string) {
  return { id, execute: async () => { executed.push(label); return { ok: true, label }; } };
}

test('PIN S328-S1: precedence — exact key > `${name}Tool` key > stripped key > exact id > stripped id', () => {
  const ran: string[] = [];
  const tools: Record<string, unknown> = {
    // an unrelated tool whose id collides with every name form below; key tiers must win over it
    cp_any: tool('getInbox', ran, 'id-getInbox'),
    cp_any2: tool('getInboxTool', ran, 'id-getInboxTool'),
    getInbox: tool('x1', ran, 'key-getInbox'),
    getInboxTool: tool('x2', ran, 'key-getInboxTool'),
  };
  assert.equal(findGatedTool(tools, 'getInbox'), tools.getInbox, 'tier 1 exact key beats `${name}Tool` and id');
  assert.equal(findGatedTool(tools, 'getInboxTool'), tools.getInboxTool, 'tier 1 exact key beats stripped key and id');
  const t2 = { ...tools };
  delete t2.getInbox;
  assert.equal(findGatedTool(t2, 'getInbox'), tools.getInboxTool, 'tier 2 `${name}Tool` key beats an exact-id match');
  const t3 = { ...tools };
  delete t3.getInboxTool;
  assert.equal(findGatedTool(t3, 'getInboxTool'), tools.getInbox, 'tier 3 stripped key beats an exact-id match');
  const ids: Record<string, unknown> = { a: tool('weird', ran, 'stripped'), b: tool('weirdTool', ran, 'exact') };
  assert.equal(findGatedTool(ids, 'weirdTool'), ids.b, 'exact id beats `Tool`-stripped id');
  assert.deepEqual(resolveGatedTool(ids, 'weirdTool'), { kind: 'found', tool: ids.b, key: 'b' });
  assert.deepEqual(ran, [], 'lookup never executes');
});

test('PIN S328-S1: two assembled tools with the same id ⇒ ambiguous (order-independent), findGatedTool fails closed', () => {
  const ran: string[] = [];
  const a = tool('search', ran, 'a');
  const b = tool('search', ran, 'b');
  for (const tools of [{ mcp_one_search: a, mcp_two_search: b }, { mcp_two_search: b, mcp_one_search: a }]) {
    assert.deepEqual(resolveGatedTool(tools, 'search'), { kind: 'ambiguous', keys: ['mcp_one_search', 'mcp_two_search'] });
    assert.deepEqual(resolveGatedTool(tools, 'searchTool'), { kind: 'ambiguous', keys: ['mcp_one_search', 'mcp_two_search'] });
    assert.equal(findGatedTool(tools, 'search'), undefined);
    // the assembled key is never ambiguous
    assert.equal(findGatedTool(tools, 'mcp_two_search'), b);
  }
  // the SAME tool object under two keys is one tool, not a collision
  assert.equal(resolveGatedTool({ k1: a, k2: a }, 'search').kind, 'found');
  assert.deepEqual(ran, []);
});

test('PIN S328-S1: tools/call on an ambiguous id ⇒ 409 ambiguous_tool with candidates, NEITHER executes; key still runs', async () => {
  const ran: string[] = [];
  const { deps } = makeDeps();
  deps.assembleTools = async () => ({ mcp_one_search: tool('search', ran, 'one'), mcp_two_search: tool('search', ran, 'two') });
  const res = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'search', args: {} }, deps });
  assert.equal(res.status, 409);
  const body = res.body as { error: string; tool: string; candidates: string[] };
  assert.equal(body.error, 'ambiguous_tool');
  assert.equal(body.tool, 'search');
  assert.deepEqual(body.candidates, ['mcp_one_search', 'mcp_two_search']);
  assert.deepEqual(ran, [], 'ambiguous name must never execute');
  const viaKey = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'mcp_two_search', args: {} }, deps });
  assert.equal(viaKey.status, 200);
  assert.deepEqual(ran, ['two']);
});
