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
  RUN_TASK_WAKE_CHAT_TASK_TOOLS,
  RUN_TASK_CAPACITY_ZERO_WARNING,
  RUN_TASK_DISABLED_WARNING,
  addMyTaskTool,
  addMyTaskRunTaskWakeTool,
  cancelMyTaskTool,
  completeMyTaskTool,
  createAddMyTaskTool,
  globalRunTaskCapacityZero,
  listMyTasksTool,
  resolveRunTaskQueueState,
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
  // asks in the live turn.
  // S243-S1 (#243 soft-pack): pins assert the full distinctive CLAUSES, not labels/keywords —
  // deleting the actual "queue instead of grind" / "simple stays live" wording fails here.
  it('#242: addMyTask queues multi-step work for Run Task instead of executing it live', () => {
    const d = addMyTaskTool.description ?? '';
    assert.match(d, /Queue work for the async Run Task queue \(taskRunner\)/);
    assert.match(d, /whenever a chat ask is NOT simple/);
    assert.match(d, /anything needing a tool loop/);
    assert.match(d, /let taskRunner execute it/);
    assert.match(d, /do NOT grind tool loops for it in the live chat turn/);
    assert.match(d, /progress returns as <task-progress …> updates/);
    assert.match(d, /Simple one-shot asks \(a plain answer, one read, a clarifying question\) stay in the live turn/);
  });

  // S243-S2 (#243 soft-pack): the SAME tool id is registered on background Run Task wakes. If the
  // wake copy kept the queue-for-Run-Task description, a Run Task wake could "queue" its own
  // work via addMyTask instead of doing it (infinite self-requeue). The wake copy must invert the
  // instruction: EXECUTE the queued work; addMyTask there is only for a genuinely NEW follow-up.
  it('S243-S2: the Run Task wake copy of addMyTask says execute the queued work — never re-queue', () => {
    assert.equal(addMyTaskRunTaskWakeTool.id, 'addMyTask', 'wake copy keeps the tool id');
    assert.deepEqual(
      Object.keys(RUN_TASK_WAKE_CHAT_TASK_TOOLS).sort(),
      Object.keys(CHAT_TASK_TOOLS).sort(),
      'wake group carries the same seven tools',
    );
    const d = addMyTaskRunTaskWakeTool.description ?? '';
    assert.match(d, /from inside a background Run Task wake/);
    assert.match(d, /EXECUTING a queued task right now/);
    assert.match(d, /do NOT call addMyTask to re-queue the work you are already executing/);
    assert.match(d, /updateMyTask \/ completeMyTask/);
    assert.match(d, /pick up LATER, after this run/);
    // The queue-first framing must NOT survive on the wake copy — that is the re-queue trap.
    assert.doesNotMatch(d, /Queue work for the async Run Task queue/);
    assert.doesNotMatch(d, /tell the human it is queued for Run Task/);
    // And the live-chat copy must not carry wake instructions (each context reads only its rule).
    assert.doesNotMatch(addMyTaskTool.description ?? '', /Run Task wake/);
  });

  it('S243-S2: assembly wires the wake copy via chatTaskTools: "run-task-wake" (wake-kind seam)', async () => {
    const chat = await assembleAgentTools(agentTestRecord, { companySettings: null, chatTaskTools: true });
    const wake = await assembleAgentTools(agentTestRecord, {
      companySettings: null,
      chatTaskTools: 'run-task-wake',
    });
    const chatAdd = chat.addMyTask as { description: string };
    const wakeAdd = wake.addMyTask as { description: string };
    assert.match(chatAdd.description, /Queue work for the async Run Task queue/);
    assert.doesNotMatch(chatAdd.description, /Run Task wake/);
    assert.match(wakeAdd.description, /from inside a background Run Task wake/);
    assert.doesNotMatch(wakeAdd.description, /Queue work for the async Run Task queue/);
    // Heartbeat assemblies still get none of the chat-task tools (unchanged invariant).
    const heartbeat = await assembleAgentTools(agentTestRecord, { companySettings: null });
    for (const id of CHAT_TASK_TOOL_IDS) assert.ok(!(id in heartbeat));
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
import { addChatTask, listChatTasks, activityLog, type ChatTaskDb } from '@tourbillon/db';
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

// ─── S243-S3 (#243 soft-pack): Run Task disabled must not leave a silent queue ──
// The handoff (#242) assumes taskRunner drains the queue. If the company disabled Run Task
// (settings.taskRunner.enabled === false — the same check the scheduler poller applies, via
// resolveTaskRunnerSettings) the Concierge must still not infinite-loop tools: addMyTask records
// the task and its RESULT carries the operator message ("enable Run Task or break the ask into
// simple steps done live in chat"). Product rule pinned in code at createAddMyTaskTool.
//
// S245-S3a (#245): the chat controller is cached per agent, so the flag computed at BUILD time
// went stale when Settings flipped taskRunner.enabled — the warning lied until the process
// restarted. The verdict is now resolved LIVE per addMyTask from the company row (the same
// source the poller re-reads every tick); the build-time flag is only the fallback when that
// read throws. S245-S3b adds the global cap-0 refusal (env TASK_RUNNER_MAX_CONCURRENT_RUNS ≤ 1
// freezes every queue — addMyTask must say so, never quietly promise a dead queue).

/** Point the LIVE company row at a taskRunner block (or clear settings entirely). */
async function setCompanyTaskRunner(
  client: PGlite,
  taskRunner: Record<string, unknown> | undefined,
): Promise<void> {
  if (taskRunner === undefined) {
    await client.exec(`update companies set settings = null where id = 'c1'`);
    return;
  }
  const json = JSON.stringify({ taskRunner }).replace(/'/g, "''");
  await client.exec(`update companies set settings = '${json}'::jsonb where id = 'c1'`);
}

/** Working chat-task db whose ONLY company-settings read throws — the db-hiccup fallback. */
function withFailingCompanyRead(db: ChatTaskDb): ChatTaskDb {
  return Object.create(db, {
    query: {
      value: {
        companies: {
          findFirst: async () => {
            throw new Error('simulated db hiccup on companies read');
          },
        },
      },
    },
  }) as unknown as ChatTaskDb;
}

/** Determinism: the capacity check reads the real env — pin/restore it around a test. */
async function withEnv<T>(raw: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS;
  if (raw === undefined) delete process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS;
  else process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS = raw;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS;
    else process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS = prev;
  }
}

const callAddMyTask = async (tool: ReturnType<typeof createAddMyTaskTool>, title: string) =>
  (await tool.execute!(
    { titles: [title] },
    { requestContext: scopeContext } as never,
  )) as ToolResult;

describe('addMyTask — Run Task disabled: LIVE verdict per ask (S243-S3 + S245-S3a)', () => {
  it('records the task but warns the operator when the company row has Run Task OFF', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      // Company flipped OFF AFTER any controller build — the live row is the truth.
      await setCompanyTaskRunner(client, { enabled: false });
      const off = createAddMyTaskTool(); // build-time flag default FALSE: live read must win
      const res = await callAddMyTask(off, 'Investigate the flaky deploy');
      assert.equal(res.ok, true, 'the task is still recorded — never dropped');
      assert.equal(res.runTaskDisabled, true);
      assert.equal(res.runTaskDisabledReason, 'company_disabled');
      assert.equal(res.message, `Added 1 task.${RUN_TASK_DISABLED_WARNING}`, 'exported warning is the one used');
      assert.match(res.message, /Run Task turned OFF \(settings taskRunner\.enabled=false\)/);
      assert.match(res.message, /no Run Task will start/);
      assert.match(res.message, /enable Run Task in Settings/);
      assert.match(res.message, /break the ask into simple steps you can do live in chat/);
      const listed = await listChatTasks(SCOPE, {}, db);
      assert.ok(listed.some((t) => t.title === 'Investigate the flaky deploy'), 'row actually written');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('S245-S3a: a stale build-time warning dies the moment the company row says enabled', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      // The exact stale-controller shape: assembled while OFF (runTaskDisabled: true captured),
      // Settings has since enabled Run Task. The live row must overrule the cached flag —
      // dropping the live re-read (the mutant) leaves this RED.
      await setCompanyTaskRunner(client, { enabled: true });
      const staleOn = createAddMyTaskTool({ runTaskDisabled: true });
      // S249-S2: budget pinned — an unpinned host env ≤ 1 would inject the capacity-zero
      // warning and fake the very stale-warning this test says is dead.
      const res = await withEnv('2', () => callAddMyTask(staleOn, 'Work the queue proves enabled'));
      assert.equal(res.ok, true);
      assert.notEqual(res.runTaskDisabled, true, 'no stale warning survives a live enabled read');
      assert.equal(res.message, 'Added 1 task.');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('no warning when Run Task is enabled (default) — normal queue path untouched', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      await withEnv('2', async () => {
        const on = createAddMyTaskTool(); // default: Run Task on
        const res = await callAddMyTask(on, 'Normal queued work');
        assert.equal(res.ok, true);
        assert.notEqual(res.runTaskDisabled, true);
        assert.equal(res.message, 'Added 1 task.');
      });
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('build-time flag only speaks when the LIVE read throws (db hiccup fallback)', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(withFailingCompanyRead(db));
      // S249-S2: budget pinned — the static-fallback=false legs reach the capacity check, so
      // an unpinned host env ≤ 1 would add a capacity-zero warning these assertions deny.
      await withEnv('2', async () => {
        const off = createAddMyTaskTool({ runTaskDisabled: true });
        const resOff = await callAddMyTask(off, 'Fallback still warns when db is down');
        assert.equal(resOff.ok, true, 'task write never depends on the settings read');
        assert.equal(resOff.runTaskDisabled, true, 'better a stale warning than silence');
        assert.equal(resOff.runTaskDisabledReason, 'company_disabled');
        assert.match(resOff.message, /Run Task turned OFF/);

        const on = createAddMyTaskTool();
        const resOn = await callAddMyTask(on, 'Fallback false stays silent too');
        assert.equal(resOn.ok, true);
        assert.notEqual(resOn.runTaskDisabled, true);
      });
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('assembly derives the build-time fallback from settings.taskRunner.enabled === false (mirrors the poller)', async () => {
    const { client, db } = await seededToolDb();
    try {
      // Company row stays enabled/null: only under a failing live read can the assembly-
      // derived flag speak — which is exactly what pins the agent-factory derivation.
      setToolDbForTests(withFailingCompanyRead(db));
      const assemble = (taskRunner: Record<string, unknown> | undefined) =>
        assembleAgentTools(agentTestRecord, {
          companySettings: { taskRunner } as never,
          chatTaskTools: true,
        });
      const callAdd = async (tools: Record<string, unknown>) =>
        (await (tools.addMyTask as { execute: (i: unknown, c: unknown) => Promise<ToolResult> }).execute(
          { titles: ['Derived check'] },
          { requestContext: scopeContext },
        ));

      // S249-S2: budget pinned — the enabled/unset legs read the real env at the capacity
      // check; this pins the DERIVATION of the fallback flag, not the host budget.
      await withEnv('2', async () => {
        const off = await callAdd(await assemble({ enabled: false }));
        assert.equal(off.ok, true);
        assert.match(off.message, /Run Task turned OFF/);

        const on = await callAdd(await assemble({ enabled: true }));
        assert.equal(on.ok, true);
        assert.doesNotMatch(on.message, /Run Task turned OFF/);

        const unset = await callAdd(await assemble(undefined));
        assert.equal(unset.ok, true);
        assert.doesNotMatch(unset.message, /Run Task turned OFF/, 'default is enabled, like the poller');
      });
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });
});

// ─── S245-S3b (#245): global cap-0 must refuse, never silently queue forever ────
// TASK_RUNNER_MAX_CONCURRENT_RUNS=0 is the scheduler kill switch; 1 reserves the only slot for
// heartbeats (defaultTaskCapPerAgent(1)=0). Either way NO Run Task can ever start — addMyTask
// must carry the honest operator message instead of promising a permanently dead queue.

describe('addMyTask — global task-capacity zero (S245-S3b)', () => {
  it('budget 0 (kill switch) and budget 1 (no task capacity) both warn with the capacity message', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      for (const raw of ['0', '1']) {
        await withEnv(raw, async () => {
          const tool = createAddMyTaskTool();
          const res = await callAddMyTask(tool, `Queued while budget ${raw}`);
          assert.equal(res.ok, true, 'still recorded — the refusal is in the message, not a write block');
          assert.equal(res.runTaskDisabled, true);
          assert.equal(res.runTaskDisabledReason, 'no_task_capacity');
          assert.equal(res.message, `Added 1 task.${RUN_TASK_CAPACITY_ZERO_WARNING}`);
          assert.match(res.message, /ZERO task capacity/);
          assert.match(res.message, /TASK_RUNNER_MAX_CONCURRENT_RUNS/);
          assert.match(res.message, /at least 2/);
          assert.match(res.message, /break the ask into simple steps you can do live in chat/);
        });
      }
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('healthy budgets (2, garbage, negative, unset) stay silent — capacity ≠ false alarm', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      for (const raw of ['2', '3', 'abc', '-1', '', undefined]) {
        await withEnv(raw, async () => {
          const res = await callAddMyTask(createAddMyTaskTool(), `Budget ${raw ?? 'unset'}`);
          assert.equal(res.ok, true);
          assert.notEqual(res.runTaskDisabled, true, `budget ${raw ?? 'unset'} is healthy`);
          assert.equal(res.message, `Added 1 task.`);
        });
      }
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('company-disabled outranks the capacity warning when both are broken', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      await setCompanyTaskRunner(client, { enabled: false });
      await withEnv('0', async () => {
        const res = await callAddMyTask(createAddMyTaskTool(), 'Both broken');
        assert.equal(res.runTaskDisabledReason, 'company_disabled', 'fix the switch before the budget');
        assert.match(res.message, /Run Task turned OFF/);
      });
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('globalRunTaskCapacityZero mirrors the scheduler parse (env injectable, pure)', async () => {
    // S249-S2: `globalRunTaskCapacityZero(undefined)` falls through to the real env via the
    // default param — pin the host env UNSET so the unset→default-2 row tests the parser,
    // not whatever TASK_RUNNER_MAX_CONCURRENT_RUNS the machine happens to carry.
    await withEnv(undefined, async () => {
      assert.equal(globalRunTaskCapacityZero('0'), true, 'kill switch');
      assert.equal(globalRunTaskCapacityZero('1'), true, 'heartbeat reservation leaves 0');
      assert.equal(globalRunTaskCapacityZero('1.5'), true, 'trunc → 1');
      assert.equal(globalRunTaskCapacityZero('2'), false);
      assert.equal(globalRunTaskCapacityZero('10'), false);
      assert.equal(globalRunTaskCapacityZero(undefined), false, 'unset → default 2');
      assert.equal(globalRunTaskCapacityZero('  '), false, 'blank → unset, not 0');
      assert.equal(globalRunTaskCapacityZero('garbage'), false, 'garbage → default 2');
      assert.equal(globalRunTaskCapacityZero('-1'), false, 'negative is garbage, not the switch');
    });
  });
});

describe('resolveRunTaskQueueState — decision matrix (S245-S3a/b, pure)', () => {
  const readReturning = (settings: unknown) => async () => settings;
  const readThrowing = async () => {
    throw new Error('db down');
  };

  it('live disabled row wins over a static false', async () => {
    const q = await resolveRunTaskQueueState('c1', false, readReturning({ taskRunner: { enabled: false } }));
    assert.equal(q.reason, 'company_disabled');
    assert.equal(q.warning, RUN_TASK_DISABLED_WARNING);
  });

  it('live enabled row clears a static true', async () => {
    // S249-S2: enabled path consults the global capacity check — pin the budget so a host
    // TASK_RUNNER_MAX_CONCURRENT_RUNS ≤ 1 cannot replace `null` with `no_task_capacity`.
    await withEnv('2', async () => {
      const q = await resolveRunTaskQueueState('c1', true, readReturning({ taskRunner: { enabled: true } }));
      assert.equal(q.reason, null);
      assert.equal(q.warning, '');
    });
  });

  it('missing company row (null settings) resolves to the poller default — enabled', async () => {
    await withEnv('2', async () => {
      const q = await resolveRunTaskQueueState('c1', true, readReturning(null));
      assert.equal(q.reason, null, 'null row is a REAL answer, not a read failure: no stale warning');
    });
  });

  it('read failure falls back to the static flag, both directions', async () => {
    await withEnv('2', async () => {
      assert.equal((await resolveRunTaskQueueState('c1', true, readThrowing)).reason, 'company_disabled');
      assert.equal((await resolveRunTaskQueueState('c1', false, readThrowing)).reason, null);
    });
  });

  it('capacity zero only speaks when the company switch is on', async () => {
    await withEnv('0', async () => {
      assert.equal((await resolveRunTaskQueueState('c1', false, readReturning(null))).reason, 'no_task_capacity');
      assert.equal(
        (await resolveRunTaskQueueState('c1', false, readReturning({ taskRunner: { enabled: false } }))).reason,
        'company_disabled',
      );
    });
    await withEnv('2', async () => {
      assert.equal((await resolveRunTaskQueueState('c1', false, readReturning(null))).reason, null);
    });
  });
});

// ─── TASK-AUDIT (#258): chat-task lifecycle rows in activity_log ─────────────
// The board audits the private chat list from the Activity page (item-type "Tasks"), so every
// agent-visible transition the TOOLS own (enqueue, status moves) must leave a chat_task.* row —
// actor = the owning agent, details carry the product lifecycle word. Reads stay silent.

async function activityRows(client: PGlite): Promise<Array<Record<string, any>>> {
  const { rows } = await client.query<{
    action: string;
    entity_type: string;
    entity_id: string;
    actor_type: string;
    actor_id: string;
    details: Record<string, unknown>;
  }>('select action, entity_type, entity_id, actor_type, actor_id, details from activity_log order by created_at');
  return rows as Array<Record<string, any>>;
}

describe('TASK-AUDIT (#258): tool-owned transitions write lifecycle audit rows', () => {
  it('addMyTask records chat_task.created (product "queued") for each task', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      const res = (await addMyTaskTool.execute!(
        { titles: ['Draft the runbook', 'Check the backup'] },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(res.ok, true);
      const rows = await activityRows(client);
      assert.equal(rows.length, 2, 'one audit row per enqueued task');
      for (const row of rows) {
        assert.equal(row.entity_type, 'chat_task');
        assert.equal(row.action, 'chat_task.created');
        assert.equal(row.actor_type, 'agent', 'the agent owns its list — actor, not system');
        assert.equal(row.actor_id, 'a1');
        assert.equal(row.details.productStatus, 'queued', 'pending stored, product word queued');
        assert.equal(row.details.threadId, 'thread-1', 'the chat thread rides on the row');
      }
      assert.deepEqual(
        rows.map((r) => r.details.title).sort(),
        ['Check the backup', 'Draft the runbook'],
      );
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('completeMyTask / cancelMyTask / updateMyTask(status) write chat_task.updated in product words', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      const task = await addChatTask(SCOPE, { title: 'Audit me' }, db);
      // Reads and renames stay silent...
      await listMyTasksTool.execute!({}, { requestContext: scopeContext } as never);
      const renamed = (await updateMyTaskTool.execute!(
        { id: task.id, title: 'Audit me (renamed)' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(renamed.ok, true);
      assert.equal((await activityRows(client)).length, 0, 'no transition → no audit row');
      // ...status moves do not.
      const done = (await completeMyTaskTool.execute!(
        { id: task.id, note: 'shipped' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(done.ok, true);
      const updated = (await updateMyTaskTool.execute!(
        { id: task.id, status: 'waiting_on_user' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(updated.ok, true);
      const cancelledTask = await addChatTask(SCOPE, { title: 'Drop me' }, db);
      await cancelMyTaskTool.execute!(
        { id: cancelledTask.id, reason: 'not needed' },
        { requestContext: scopeContext } as never,
      );
      const rows = await activityRows(client);
      assert.equal(rows.length, 3);
      // Identify by content, not row order (created_at can tie inside one millisecond).
      const doneRow = rows.find((r) => r.details.changes?.status?.to === 'done')!;
      const waitingRow = rows.find((r) => r.details.changes?.status?.to === 'waiting_on_user')!;
      const cancelRow = rows.find((r) => r.entity_id === cancelledTask.id)!;
      assert.ok(doneRow && waitingRow && cancelRow, `expected 3 distinct rows, got ${JSON.stringify(rows)}`);
      assert.equal(doneRow.action, 'chat_task.updated');
      // S263-S4: tool rows carry the "from" side too, matching the runner rows' pairing.
      assert.deepEqual(doneRow.details.changes, { status: { from: 'pending', to: 'done' } });
      assert.equal(doneRow.details.previousStatus, 'pending');
      assert.equal(doneRow.details.previousProductStatus, 'queued', 'from-side product word');
      assert.equal(doneRow.details.productStatus, 'done');
      assert.equal(waitingRow.details.productStatus, 'error', 'waiting_on_user reads as error to the board');
      assert.deepEqual(waitingRow.details.changes, { status: { from: 'done', to: 'waiting_on_user' } });
      assert.equal(waitingRow.details.previousProductStatus, 'done');
      assert.deepEqual(cancelRow.details.changes, { status: { from: 'pending', to: 'cancelled' } });
      assert.equal(cancelRow.details.previousStatus, 'pending');
      assert.equal(cancelRow.details.reason, 'not needed');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('a failing audit write never loses the task (best-effort contract)', async () => {
    const { client, db } = await seededToolDb();
    try {
      // Break ONLY the activity insert: every other table behaves normally.
      const broken = Object.create(db, {
        insert: {
          value: (table: unknown) => {
            if (table === activityLog) throw new Error('activity db down');
            return (db as never as { insert: (t: unknown) => never }).insert(table);
          },
        },
      }) as ChatTaskDb;
      setToolDbForTests(broken);
      const res = (await addMyTaskTool.execute!(
        { titles: ['Survive the audit outage'] },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(res.ok, true, 'the task is written even when the audit row cannot be');
      const tasks = await listChatTasks(SCOPE, {}, db);
      assert.equal(tasks.length, 1);
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('S263-S3 (#263 softs): the swallowed tool-side audit failure is LOUD — a warn names the task and error', async () => {
    const { client, db } = await seededToolDb();
    try {
      const task = await addChatTask(SCOPE, { title: 'Report on the outage' }, db);
      const broken = Object.create(db, {
        insert: {
          value: (table: unknown) => {
            if (table === activityLog) throw new Error('activity db down');
            return (db as never as { insert: (t: unknown) => never }).insert(table);
          },
        },
      }) as ChatTaskDb;
      setToolDbForTests(broken);

      const warns: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(' '));
      };
      try {
        const res = (await completeMyTaskTool.execute!(
          { id: task.id, note: 'done despite the audit outage' },
          { requestContext: scopeContext } as never,
        )) as ToolResult;
        assert.equal(res.ok, true, 'best-effort contract holds: the settle still lands');
      } finally {
        console.warn = originalWarn;
      }
      const hit = warns.find((w) => w.includes('chat-task activity log failed'));
      assert.ok(hit, 'the failed audit insert is logged, not silently swallowed');
      assert.match(hit!, new RegExp(String(task.id)));
      assert.match(hit!, /activity db down/, 'the underlying error travels with the line');
      const [row] = await listChatTasks(SCOPE, { includeClosed: true }, db);
      assert.equal(row!.status, 'done');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });

  it('S263-S4 (#263 softs): a no-op status move writes NO audit row (same status is not a transition)', async () => {
    const { client, db } = await seededToolDb();
    try {
      setToolDbForTests(db);
      const task = await addChatTask(SCOPE, { title: 'Settle once' }, db);

      const first = (await completeMyTaskTool.execute!(
        { id: task.id },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(first.ok, true);
      assert.equal((await activityRows(client)).length, 1, 'the real pending → done move is audited');

      // Re-completing an already-done task: still ok for the caller, still no second row.
      const again = (await completeMyTaskTool.execute!(
        { id: task.id },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(again.ok, true);
      assert.equal((await activityRows(client)).length, 1, 'done → done is not a transition');

      // updateMyTask to the status the task already holds: row-silent too.
      const same = (await updateMyTaskTool.execute!(
        { id: task.id, status: 'done' },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(same.ok, true);
      assert.equal((await activityRows(client)).length, 1, 'same-status updateMyTask writes no row');

      // And cancelling a cancelled task the same way.
      const cancelled = await addChatTask(SCOPE, { title: 'Drop twice' }, db);
      await cancelMyTaskTool.execute!({ id: cancelled.id }, { requestContext: scopeContext } as never);
      const cancelRowsBefore = (await activityRows(client)).length;
      assert.equal(cancelRowsBefore, 2, 'the real pending → cancelled move is audited');
      const cancelAgain = (await cancelMyTaskTool.execute!(
        { id: cancelled.id },
        { requestContext: scopeContext } as never,
      )) as ToolResult;
      assert.equal(cancelAgain.ok, true);
      assert.equal((await activityRows(client)).length, 2, 'cancelled → cancelled stays row-silent');
    } finally {
      setToolDbForTests(null);
      await client.close();
    }
  });
});
