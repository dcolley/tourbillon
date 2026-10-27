/**
 * TASK-1 unit tests — the five private chat-task list tools (mastra side).
 *
 * Covers:
 *  - AC3: the five ids appear in the CHAT tool assembly (chatTaskTools flag) and nowhere
 *    else — not CONTROL_PLANE_TOOLS, not any ROLE_TOOLS set, not the heartbeat assembly;
 *  - AC5: a call whose request context carries no agentId/companyId returns an error,
 *    reads/writes nothing, and no input schema carries a model-supplied scope id.
 *
 * Query-layer scope isolation (agent A vs agent B, company X vs Y, survive-Clear) lives in
 * @tourbillon/db (`chat-task-queries.test.ts`). Nothing here needs a live database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAT_TASK_TOOLS,
  CHAT_TASK_TOOL_IDS,
  addMyTaskTool,
  cancelMyTaskTool,
  completeMyTaskTool,
  listMyTasksTool,
  updateMyTaskTool,
} from './chat-task-tools';
import { CONTROL_PLANE_TOOLS } from './control-plane-tools';
import { ROLE_TOOLS } from './role-tools';
import { assembleAgentTools } from '../agent-factory';
import { setToolDbForTests, toolDb } from './tool-db';

const agentTestRecord = {
  id: 'agent-test-1',
  companyId: 'company-test-1',
  name: 'Test Agent',
  role: 'cto',
  urlKey: 'test-agent',
  adapterType: 'lmstudio',
  adapterConfig: {},
  modelId: 'test/model',
  runtimeConfig: {},
  assignedToolsets: [],
  assignedSkills: ['control-plane'],
  mcpServerIds: [],
} as unknown as Parameters<typeof assembleAgentTools>[0];

describe('CHAT_TASK_TOOLS — chat-only registration (AC3)', () => {
  it('is absent from CONTROL_PLANE_TOOLS, every ROLE_TOOLS set and the heartbeat assembly', async () => {
    const heartbeat = await assembleAgentTools(agentTestRecord, { companySettings: null });
    const heartbeatKeys = Object.keys(heartbeat);
    for (const id of CHAT_TASK_TOOL_IDS) {
      assert.ok(!Object.keys(CONTROL_PLANE_TOOLS).includes(id), `${id} must not be a control-plane tool`);
      for (const [toolsetId, toolSet] of Object.entries(ROLE_TOOLS)) {
        assert.ok(!Object.keys(toolSet).includes(id), `${id} must not be in the ${toolsetId} toolset`);
      }
      assert.ok(!heartbeatKeys.includes(id), `${id} leaked into the heartbeat toolset`);
    }
  });

  it('is present in the chat assembly (chatTaskTools), on top of the heartbeat set', async () => {
    const base = Object.keys(await assembleAgentTools(agentTestRecord, { companySettings: null }));
    const chat = Object.keys(
      await assembleAgentTools(agentTestRecord, { companySettings: null, chatTaskTools: true }),
    );
    for (const id of CHAT_TASK_TOOL_IDS) {
      assert.ok(chat.includes(id), `${id} missing from the chat toolset`);
      assert.ok(!base.includes(id), `${id} must not be in the heartbeat toolset`);
    }
    assert.equal(chat.length, base.length + CHAT_TASK_TOOL_IDS.length);
  });
});

describe('CHAT_TASK_TOOLS — scope from the request context only (AC5)', () => {
  // A database seam that flags ANY access — a tool that queried it without a valid scope
  // would trip the flag (and the assertion) instead of quietly reading/writing rows.
  let dbTouched = false;
  const spyDb = new Proxy(
    {},
    {
      get: () => () => {
        dbTouched = true;
        throw new Error('chat-task tool reached the database without a valid scope');
      },
    },
  );

  const contextsWithoutScope: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    Object.create(null), // no `get` at all
    new Map<string, string>(), // has `get`, but it knows nothing
  ];

  it('errors and touches nothing without agentId+companyId in the context', async () => {
    setToolDbForTests(spyDb as never);
    try {
      const calls = [
        [listMyTasksTool, { includeClosed: true }],
        [addMyTaskTool, { titles: ['Draft the runbook'] }],
        [updateMyTaskTool, { id: 'task-1', status: 'done' }],
        [completeMyTaskTool, { id: 'task-1' }],
        [cancelMyTaskTool, { id: 'task-1', reason: 'dropped' }],
      ] as const;
      for (const [tool, input] of calls) {
        for (const requestContext of contextsWithoutScope) {
          const result = (await tool.execute!(
            input as never,
            { requestContext } as never,
          )) as Record<string, unknown>;
          assert.equal(result.error, 'missing_scope', `${tool.id} without scope -> ${JSON.stringify(result)}`);
          assert.ok(!('tasks' in result) && !('task' in result) && !('count' in result));
        }
      }
      assert.equal(dbTouched, false, 'no tool may read the database without a scope');
    } finally {
      setToolDbForTests(null);
    }
  });

  it('carries no model-supplied agent/company id parameter, and says it is NOT company issues', () => {
    for (const tool of Object.values(CHAT_TASK_TOOLS)) {
      const shape = (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
      assert.ok(!('agentId' in shape), `${tool.id} exposes an agentId parameter`);
      assert.ok(!('companyId' in shape), `${tool.id} exposes a companyId parameter`);
      assert.match(tool.description, /NOT company issues/, `${tool.id} keeps the issues boundary`);
    }
    // The five stay clearly separate from the issue tools (getInbox et al).
    assert.ok('getInboxTool' in CONTROL_PLANE_TOOLS);
    assert.ok(!('getInbox' in CHAT_TASK_TOOLS));
    assert.equal(typeof toolDb, 'function');
  });
});
