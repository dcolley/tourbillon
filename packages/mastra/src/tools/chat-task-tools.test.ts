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

  // S6 (#193): the showTaskList card can never be asked with an empty list (`tasks.min(1)`), so the
  // tool description must send the agent to a text answer instead of a doomed card call.
  it('S6: an empty list answers in text - listMyTasks steers the agent off an empty showTaskList card', () => {
    assert.match(listMyTasksTool.description, /if the list is empty, answer in plain text/);
    assert.match(listMyTasksTool.description, /do not call showTaskList/);
    assert.match(listMyTasksTool.description, /at least one task/);
  });

  // #242 (CHAT-TASK-HANDOFF): addMyTask is the queue-for-Run-Task entry point. The copy must keep
  // sending multi-step chat work to taskRunner instead of a live-turn tool loop, and keep simple
  // asks in the live turn — deleting any of these clauses silently reverts to in-turn grinding.
  it('#242: addMyTask queues multi-step work for Run Task instead of executing it live', () => {
    const d = addMyTaskTool.description ?? '';
    assert.match(d, /Run Task queue \(taskRunner\)/);
    assert.match(d, /do NOT grind tool loops for it in the live chat turn/);
    assert.match(d, /<task-progress/);
    assert.match(d, /queued for Run Task/);
    assert.match(d, /Simple one-shot asks/);
  });
});

// ─── S7 (#196 soft-pack): the two Run Task controls, driven end-to-end ──────
// pauseMyTask / prioritizeMyTask had NO behaviour tests (only the chat-registration and
// missing-scope paths above). These run the real tools against an in-memory Postgres through
// the toolDb() seam: pausing must gate the Run Task queue flag, and prioritising must make the
// task genuinely sort first (S9: an older row at position 0 used to win the createdAt tiebreak).

import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as dbSchema from '@tourbillon/db/schema';
import { addChatTask, listChatTasks, type ChatTaskDb } from '@tourbillon/db';
import { pauseMyTaskTool, prioritizeMyTaskTool } from './chat-task-tools';

const MIGRATIONS_DIR = path.join(__dirname, '../../../db/src/migrations');
const SCOPE = { companyId: 'c1', agentId: 'a1' };
const scopeContext = new Map([
  ['agentId', 'a1'],
  ['companyId', 'c1'],
  ['threadId', 'thread-1'],
]);

async function seededToolDb(): Promise<{ client: PGlite; db: ChatTaskDb }> {
  const client = new PGlite();
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
  }
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c1', 'Other Agent', 'engineer', 'Engineer', 'other-agent');
  `);
  return { client, db: drizzlePglite(client, { schema: dbSchema }) as unknown as ChatTaskDb };
}

type ToolResult = Record<string, any>;

describe('pauseMyTask + prioritizeMyTask — Run Task controls (S7, #196 soft-pack)', () => {
  it('pauseMyTask pauses by default (Run Task skips it), resumes on request, and 404s foreign ids', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      const task = await addChatTask(SCOPE, { title: 'Hold this' }, db);

      const paused = (await pauseMyTaskTool.execute!(
        { id: task.id },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(paused.ok, true);
      assert.match(paused.message, /paused — Run Task will skip it/);
      assert.equal((await listChatTasks(SCOPE, {}, db)).find((t) => t.id === task.id)?.paused, true);

      const resumed = (await pauseMyTaskTool.execute!(
        { id: task.id, paused: false },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(resumed.ok, true);
      assert.match(resumed.message, /resumed — eligible for Run Task again/);
      assert.equal((await listChatTasks(SCOPE, {}, db)).find((t) => t.id === task.id)?.paused, false);

      const foreign = (await pauseMyTaskTool.execute!(
        { id: 'nope' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(foreign.error, 'task_not_found');

      const scoped = (await pauseMyTaskTool.execute!({ id: task.id }, {} as never)) as ToolResult;
      assert.equal(scoped.error, 'missing_scope');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('prioritizeMyTask (default) truly sorts first — the S9 createdAt tiebreak fix', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      const older = await addChatTask(SCOPE, { title: 'Older at zero' }, db); // position 0
      const target = await addChatTask(SCOPE, { title: 'Front of the queue', position: 2 }, db);
      // Deterministic tiebreak setup: `older` was created strictly before `target`.
      await client.query(`update chat_tasks set created_at = '2026-01-01T00:00:00Z'::timestamptz where id = $1`, [older.id]);

      const moved = (await prioritizeMyTaskTool.execute!(
        { id: target.id },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(moved.ok, true);
      assert.match(moved.message, /front of your list/);
      // Pre-fix this landed on position 0, tied with `older`, and the createdAt tiebreak kept
      // the older task ahead — the "prioritised" task was still claimed last.
      const listed = await listChatTasks(SCOPE, {}, db);
      const storedTarget = listed.find((t) => t.id === target.id)!;
      const storedOlder = listed.find((t) => t.id === older.id)!;
      assert.ok(
        storedTarget.position < storedOlder.position && storedTarget.position < 0,
        `front move must go below every other row, got target=${storedTarget.position} older=${storedOlder.position}`,
      );
      assert.equal(listed[0]!.id, target.id, 'the prioritised task sorts first');
      assert.equal(listed[1]!.id, older.id, 'the older task falls back behind it');

      // Explicit position still passes through untouched.
      const explicit = (await prioritizeMyTaskTool.execute!(
        { id: older.id, position: 5 },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(explicit.ok, true);
      assert.equal((await listChatTasks(SCOPE, {}, db)).find((t) => t.id === older.id)?.position, 5);

      const foreign = (await prioritizeMyTaskTool.execute!(
        { id: 'nope' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(foreign.error, 'task_not_found');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });
});
