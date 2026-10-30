/**
 * TASK-AUDIT (#258): the chat_task lifecycle audit writer against an in-memory Postgres
 * (PGlite) with the repo's own migrations. Pins:
 *  - one activity_log row per transition with entity_type 'chat_task', the lifecycle action,
 *    the actor (agent-owned edits = agent actor; runner rows = system) and the details payload
 *    the Activity view links off (runId, agentId, productStatus);
 *  - best-effort contract: a failing insert never throws at the queue caller (with or without
 *    an onError sink);
 *  - the documented lifecycle map's product words (pending→queued, in_progress→running,
 *    waiting_on_user→error, done→done, cancelled→cancelled).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema/index';
import { activityLog } from './schema/activity-log';
import { chatTaskProductStatus, recordChatTaskActivity, CHAT_TASK_ACTIVITY_ACTIONS } from './chat-task-activity';

const MIGRATIONS = path.join(__dirname, 'migrations');

async function freshDb() {
  const client = new PGlite();
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH');
    insert into agents (id, company_id, name, role, title, url_key) values ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant');
    insert into chat_tasks (id, company_id, agent_id, title) values ('t1', 'c1', 'a1', 'Ship the runbook');
  `);
  return { client, db };
}

describe('recordChatTaskActivity (#258)', () => {
  it('writes one activity_log row per transition with the lifecycle action and link details', async () => {
    const { client, db } = await freshDb();
    try {
      await recordChatTaskActivity(
        {
          companyId: 'c1',
          taskId: 't1',
          action: 'chat_task.started',
          actorType: 'system',
          actorId: 'task-runner',
          actorName: 'Task runner',
          details: { agentId: 'a1', runId: 'r1', status: 'in_progress', productStatus: 'running' },
        },
        { database: db as never },
      );
      const rows = await client.query<{
        entity_type: string;
        entity_id: string;
        action: string;
        actor_type: string;
        actor_id: string;
        details: Record<string, unknown>;
      }>(`select * from activity_log`);
      assert.equal(rows.rows.length, 1);
      const row = rows.rows[0]!;
      assert.equal(row.entity_type, 'chat_task');
      assert.equal(row.entity_id, 't1');
      assert.equal(row.action, 'chat_task.started');
      assert.equal(row.actor_type, 'system');
      assert.equal(row.actor_id, 'task-runner');
      assert.equal(row.details.runId, 'r1');
      assert.equal(row.details.productStatus, 'running');
    } finally {
      await client.close();
    }
  });

  it('agent-owned edits carry the owning agent as the actor', async () => {
    const { client, db } = await freshDb();
    try {
      await recordChatTaskActivity(
        {
          companyId: 'c1',
          taskId: 't1',
          action: 'chat_task.created',
          actorType: 'agent',
          actorId: 'a1',
          details: { title: 'Ship the runbook', productStatus: 'queued' },
        },
        { database: db as never },
      );
      const [row] = await db.select().from(activityLog);
      assert.equal(row?.actorType, 'agent');
      assert.equal(row?.actorId, 'a1');
      assert.equal(row?.action, 'chat_task.created');
      assert.equal(row?.entityId, 't1');
    } finally {
      await client.close();
    }
  });

  it('is best-effort: a failing insert never throws, and reports through onError', async () => {
    const broken = {
      insert: () => {
        throw new Error('activity db down');
      },
    } as never;
    // No sink → silent swallow.
    await recordChatTaskActivity(
      { companyId: 'c1', taskId: 't1', action: 'chat_task.done', actorType: 'system', actorId: 'task-runner' },
      { database: broken },
    );
    // With a sink → the caller hears about it, still without a throw.
    const seen: unknown[] = [];
    await recordChatTaskActivity(
      { companyId: 'c1', taskId: 't1', action: 'chat_task.parked', actorType: 'system', actorId: 'task-runner' },
      { database: broken, onError: (e) => seen.push(e) },
    );
    assert.equal(seen.length, 1);
  });

  it('exposes exactly the documented lifecycle actions', () => {
    assert.deepEqual([...CHAT_TASK_ACTIVITY_ACTIONS].sort(), [
      'chat_task.created',
      'chat_task.done',
      'chat_task.error',
      'chat_task.parked',
      'chat_task.queued',
      'chat_task.started',
      'chat_task.updated',
    ]);
  });
});

describe('chatTaskProductStatus (#258 lifecycle map)', () => {
  it('maps the stored words onto the product lifecycle words', () => {
    assert.equal(chatTaskProductStatus('pending'), 'queued');
    assert.equal(chatTaskProductStatus('in_progress'), 'running');
    assert.equal(chatTaskProductStatus('waiting_on_user'), 'error');
    assert.equal(chatTaskProductStatus('done'), 'done');
    assert.equal(chatTaskProductStatus('cancelled'), 'cancelled');
  });
});
