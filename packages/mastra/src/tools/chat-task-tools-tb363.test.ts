/**
 * TB-363 — the tool-driven emit path (contract A11 + S3). Every writer that moves a chat task
 * into done or waiting_on_user (with the ask) must publish EXACTLY ONE chat_task_progress event
 * with the runner's identity scheme (companyId:chatTaskId:runId:stage), so the bridge claim
 * collapses a tool move and the runner settle of the same transition into one notice.
 * Base bdd1d970: updateMyTask / completeMyTask published NOTHING (root cause R3) — these tests
 * import the publish seam that only exists after the fix.
 *
 * Real drizzle over PGlite (same pattern as tool-discovery-tools.test.ts): the assertions run
 * through the tool's PUBLIC execute() seam, not the publish helper directly.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as dbSchema from '@tourbillon/db/schema';
import { updateMyTaskTool, completeMyTaskTool } from './chat-task-tools';
import { setToolDbForTests, type ToolDb } from './tool-db';
import {
  setChatTaskProgressPublisher,
  publishChatTaskProgress,
  type ChatTaskProgressPublishEvent,
} from '../concierge-signal';

const MIGRATIONS_DIR = path.join(__dirname, '../../../db/src/migrations');

const CO = 'tb363-company';
const AG = 'tb363-agent';

let client: PGlite;
let seededDb: ToolDb;
let published: ChatTaskProgressPublishEvent[];
let warnLines: unknown[][];

const context = { requestId: 'tb363-req', agentId: AG, companyId: CO, runId: 'run-7' };

async function seedTask(status: string, notes: string | null = null): Promise<void> {
  await seededDb
    .insert(dbSchema.chatTasks)
    .values({ id: 'tb363-task', companyId: CO, agentId: AG, title: 'Ship the runbook', status, notes } as never);
}

describe('TB-363 A11a — tool-driven transitions publish exactly one progress event', () => {
  before(async () => {
    client = new PGlite();
    for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) {
      for (const chunk of m.sql) if (chunk.trim()) await client.exec(chunk);
    }
    seededDb = drizzlePglite(client, { schema: dbSchema }) as unknown as ToolDb;
  });

  after(async () => {
    setChatTaskProgressPublisher(null);
    setToolDbForTests(null);
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec('TRUNCATE companies CASCADE');
    await seededDb
      .insert(dbSchema.companies)
      .values({ id: CO, name: CO, slug: CO, issuePrefix: 'TB', createdAt: new Date(), updatedAt: new Date() } as never);
    await seededDb
      .insert(dbSchema.agents)
      .values({
        id: AG, companyId: CO, name: 'TB Agent', urlKey: 'tb-agent', title: 'TB Agent', role: 'cto',
        assignedSkills: [], assignedToolsets: [], runtimeConfig: {}, adapterType: 'lmstudio', modelId: 'test/model',
        active: true, createdAt: new Date(), updatedAt: new Date(),
      } as never);
    published = [];
    setChatTaskProgressPublisher((e) => {
      published.push(e);
    });
    warnLines = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLines.push(args);
    };
    (console.warn as unknown as { __real?: unknown }).__real = realWarn;
    setToolDbForTests(seededDb);
  });

  afterEach(() => {
    const wrapped = console.warn as unknown as { __real?: (...a: unknown[]) => void };
    if (wrapped.__real) console.warn = wrapped.__real.bind(console);
    setChatTaskProgressPublisher(null);
    setToolDbForTests(null);
  });

  it('A11a: completeMyTask publishes exactly one done event with the runner identity fields', async () => {
    await seedTask('in_progress');
    const result = (await completeMyTaskTool.execute!({ id: 'tb363-task' }, { requestContext: context } as never)) as {
      ok: boolean;
      task?: { status: string };
    };
    assert.equal(result.ok, true);
    assert.equal(result.task?.status, 'done');
    assert.equal(published.length, 1, 'exactly one event for the tool-driven completion');
    assert.deepEqual(
      {
        companyId: published[0]!.companyId,
        agentId: published[0]!.agentId,
        chatTaskId: published[0]!.chatTaskId,
        runId: published[0]!.runId,
        stage: published[0]!.stage,
        status: published[0]!.status,
        title: published[0]!.title,
      },
      {
        companyId: CO,
        agentId: AG,
        chatTaskId: 'tb363-task',
        runId: 'run-7',
        stage: 'done',
        status: 'succeeded',
        title: 'Ship the runbook',
      },
      'same identity scheme as the runner (companyId:chatTaskId:runId:stage) so the bridge claim collapses tool+runner',
    );
  });

  it('A11a: updateMyTask into waiting_on_user publishes one event carrying the stated ask', async () => {
    await seedTask('in_progress');
    const result = (await updateMyTaskTool.execute!(
      { id: 'tb363-task', status: 'waiting_on_user', ask: 'Pick vendor A or B' },
      { requestContext: context } as never,
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(published.length, 1);
    assert.equal(published[0]!.stage, 'waiting_on_user');
    assert.equal(published[0]!.detail, 'Pick vendor A or B', 'the ask rides the event (A2 needs it in the notice)');
  });

  it('A11a: a no-op status move (same status) publishes nothing — the audit stays the record', async () => {
    await seedTask('pending');
    await updateMyTaskTool.execute!({ id: 'tb363-task', status: 'pending' }, { requestContext: context } as never);
    assert.equal(published.length, 0);
  });

  it('A11/S2: pending / in_progress / cancelled moves publish no notice (runner owns started; cancel stays silent)', async () => {
    await seedTask('waiting_on_user', 'ask: which env?');
    await updateMyTaskTool.execute!({ id: 'tb363-task', status: 'pending' }, { requestContext: context } as never);
    await updateMyTaskTool.execute!({ id: 'tb363-task', status: 'cancelled' }, { requestContext: context } as never);
    assert.equal(published.length, 0, 're-queues belong to the runner started notice; cancel never looks like done/failed');
  });

  it('A10: root cause R3 — a concierge tool move that changes status MUST publish chat_task_progress (base published nothing)', async () => {
    await seedTask('in_progress');
    await completeMyTaskTool.execute!({ id: 'tb363-task' }, { requestContext: context } as never);
    assert.ok(
      published.length === 1,
      'ROOT CAUSE R3 (packages/mastra/src/tools/chat-task-tools.ts completeMyTask): tool-driven done produced 0 progress events',
    );
  });

  it('S3: with no publisher wired the tool move still succeeds but the lost announce is logged, never silent', async () => {
    setChatTaskProgressPublisher(null);
    await seedTask('in_progress');
    const result = (await completeMyTaskTool.execute!({ id: 'tb363-task' }, { requestContext: context } as never)) as {
      ok: boolean;
    };
    assert.equal(result.ok, true, 'a missing publisher must never fail the tool call');
    assert.ok(
      warnLines.some((w) => JSON.stringify(w).includes('chat-task-progress')),
      'the silent-loss path is surfaced via console.warn (S3 / M16)',
    );
  });

  const chatContext = { requestId: 'tb363-req-2', agentId: AG, companyId: CO, runId: `chat-${AG}` };

  it('S-1: two real waiting_on_user moves in one chat session (constant runId) get DISTINCT per-transition ids', async () => {
    await seedTask('in_progress');
    await updateMyTaskTool.execute!(
      { id: 'tb363-task', status: 'waiting_on_user', ask: 'Pick vendor A or B' },
      { requestContext: chatContext } as never,
    );
    await new Promise((r) => setTimeout(r, 10));
    await updateMyTaskTool.execute!(
      { id: 'tb363-task', status: 'in_progress' },
      { requestContext: chatContext } as never,
    );
    await updateMyTaskTool.execute!(
      { id: 'tb363-task', status: 'waiting_on_user', ask: 'Confirm the PO number' },
      { requestContext: chatContext } as never,
    );
    const asks = published.filter((e) => e.stage === 'waiting_on_user');
    assert.equal(asks.length, 2, 'both asks published');
    assert.ok(asks.every((e) => e.runId.startsWith('tool:')), 'live-chat transitions carry per-transition ids, not the constant session runId');
    assert.notEqual(asks[0]!.runId, asks[1]!.runId, 'S-1: the second ask does NOT collapse into the first claim (900 s TTL)');
    assert.ok(!asks.some((e) => e.runId === `chat-${AG}`), 'the constant chat runId never rides as the transition identity');
  });

  it('S-1 control: a Run Task wake context keeps the EXACT runner runId so tool emit + runner settle collapse (A11b)', async () => {
    await seedTask('in_progress');
    await completeMyTaskTool.execute!({ id: 'tb363-task' }, { requestContext: context } as never);
    assert.equal(published.length, 1);
    assert.equal(published[0]!.runId, 'run-7', 'runner-origin identity stays exact');
  });

  it('MUST-4: every tool-published transition carries source:tool (the bridge persists it without a wake)', async () => {
    await seedTask('in_progress');
    await completeMyTaskTool.execute!({ id: 'tb363-task' }, { requestContext: chatContext } as never);
    assert.equal(published.length, 1);
    assert.equal(published[0]!.source, 'tool', 'the bridge keys its no-wake policy on this marker');
  });
});

describe('TB-363 A11 — the publish seam itself', () => {
  it('A11: publishChatTaskProgress clamps detail to the 300-char event cap and fires the publisher once', () => {
    const got: ChatTaskProgressPublishEvent[] = [];
    setChatTaskProgressPublisher((e) => {
      got.push(e);
    });
    try {
      const ok = publishChatTaskProgress({
        companyId: 'c',
        agentId: 'a',
        chatTaskId: 't',
        runId: 'r',
        stage: 'waiting_on_user',
        status: 'succeeded',
        title: 'T',
        detail: 'x'.repeat(400),
      });
      assert.equal(ok, true);
      assert.equal(got.length, 1);
      assert.equal(got[0]!.detail!.length, 300);
    } finally {
      setChatTaskProgressPublisher(null);
    }
  });

  it('S3: a throwing publisher is caught and warned — it must never fail the caller', () => {
    setChatTaskProgressPublisher(() => {
      throw new Error('redis down');
    });
    const realWarn = console.warn;
    const seen: unknown[][] = [];
    console.warn = (...a: unknown[]) => {
      seen.push(a);
    };
    try {
      const ok = publishChatTaskProgress({
        companyId: 'c',
        agentId: 'a',
        chatTaskId: 't',
        runId: 'r',
        stage: 'done',
        status: 'succeeded',
        title: 'T',
      });
      assert.doesNotThrow(() => ok);
      assert.ok(seen.length >= 1, 'the failure is surfaced (S3), never silent');
    } finally {
      console.warn = realWarn;
      setChatTaskProgressPublisher(null);
    }
  });
});
