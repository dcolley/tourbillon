/**
 * TASK-1 unit tests: the chat-task query layer against an in-memory Postgres (PGlite),
 * with the repo's own migrations applied. No external database is touched.
 *
 * The binding behaviours: one private list per (company, agent) — agent A can never read or
 * mutate agent B's rows, one company never sees another's — and the list is keyed by that
 * (company, agent) scope, NOT the Mastra thread, so Clear chat (a new thread) keeps the list.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema/index';
import {
  addChatTask,
  claimChatTaskRun,
  countOpenChatTasks,
  finishChatTaskRun,
  listChatTasks,
  listPendingChatTaskCompanySettings,
  listRunnableChatTasks,
  prioritizeChatTask,
  setChatTaskPaused,
  setChatTaskStatus,
  updateChatTask,
} from './chat-task-queries';

const MIGRATIONS = path.join(__dirname, 'migrations');
const JOURNAL = (
  JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  }
).entries;
/** Latest migration in the journal (TASK-RUNNER bumped the schema at 0024 — the runner
 *  columns paused/runner_attempts/runner_last_run_id must exist before any addChatTask). */
const WHEN_LATEST = JOURNAL[JOURNAL.length - 1]!.when;

/** Apply every migration in the journal (same rule as drizzle's migrator). */
async function migrateUp(client: PGlite): Promise<void> {
  await client.exec(`
    create schema if not exists drizzle;
    create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS })) {
    if (m.folderMillis > WHEN_LATEST) break;
    for (const chunk of m.sql) {
      if (chunk.trim()) await client.exec(chunk);
    }
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

/** Fresh in-memory db with the schema migrated and two companies / three agents seeded. */
async function freshDb() {
  const client = new PGlite();
  await migrateUp(client);
  const db = drizzle(client, { schema });
  await client.exec(`
    insert into companies (id, name, slug, issue_prefix) values ('c1', 'Bug Hunt', 'bug-hunt', 'BH'), ('c2', 'Other Co', 'other', 'OC');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('a1', 'c1', 'Assistant', 'cto', 'The Assistant', 'assistant'),
      ('a2', 'c1', 'Other Agent', 'engineer', 'Engineer', 'other-agent'),
      ('b1', 'c2', 'Foreign Agent', 'engineer', 'Engineer', 'foreign-agent');
  `);
  return { client, db };
}

const A1 = { companyId: 'c1', agentId: 'a1' };
const A2 = { companyId: 'c1', agentId: 'a2' };
const B1 = { companyId: 'c2', agentId: 'b1' };

describe('chat-task query layer', () => {
  it('adds to the tail (position), lists open items, and round-trips every status', async () => {
    const { client, db } = await freshDb();
    try {
      const first = await addChatTask(A1, { title: 'Draft the runbook' }, db);
      const second = await addChatTask(A1, { title: 'Check the restore backup', sourceThreadId: 'thread-1' }, db);
      assert.equal(first.position, 0);
      assert.equal(second.position, 1);
      assert.equal(first.status, 'pending');

      let listed = await listChatTasks(A1, {}, db);
      assert.deepEqual(listed.map((t) => t.title), ['Draft the runbook', 'Check the restore backup']);

      // Every status round-trips; done/cancelled are hidden by default and shown with includeClosed.
      assert(await setChatTaskStatus(A1, { id: first.id, status: 'in_progress' }, db));
      assert(await setChatTaskStatus(A1, { id: second.id, status: 'waiting_on_user' }, db));
      listed = await listChatTasks(A1, {}, db);
      assert.equal(listed.length, 2);
      assert.equal(countOpenSafe(listed), 2);

      const done = await addChatTask(A1, { title: 'Done thing', status: 'done' }, db);
      assert.ok(done.completedAt, 'adding as done stamps completedAt immediately');
      const cancelled = await setChatTaskStatus(A1, { id: first.id, status: 'cancelled', note: 'No longer needed.' }, db);
      assert.equal(cancelled?.status, 'cancelled');

      const open = await listChatTasks(A1, {}, db);
      const everything = await listChatTasks(A1, { includeClosed: true }, db);
      assert.equal(open.length, 1); // only the waiting_on_user backup stays open
      assert.equal(everything.length, 3); // runbook cancelled + backup waiting + Done thing done
      assert.equal(await countOpenChatTasks(A1, db), 1);

      // A done/cancelled item can move back to an open status (the enum is a CHECK, not a rail).
      const reopened = await setChatTaskStatus(A1, { id: cancelled!.id, status: 'pending' }, db);
      assert.equal(reopened?.status, 'pending');
      assert.equal(reopened?.completedAt, null);
    } finally {
      await client.close();
    }
  });

  it('keeps one list per agent and per company — cross-scope reads and writes are impossible', async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(A1, { title: 'Private to the Assistant' }, db);
      const other = await addChatTask(A2, { title: 'Private to the other agent' }, db);

      // Agent A2 cannot see agent A1's task (same company)...
      assert.deepEqual((await listChatTasks(A2, {}, db)).map((t) => t.id), [other.id]);
      // ...and neither can an agent in another company.
      assert.deepEqual((await listChatTasks(B1, {}, db)).map((t) => t.id), []);
      assert.equal(await countOpenChatTasks(B1, db), 0);

      // Mutating another agent's (or another company's) task id is a no-op, not a write.
      assert.equal(await updateChatTask(A2, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await updateChatTask(B1, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await setChatTaskStatus(A2, { id: task.id, status: 'cancelled' }, db), null);
      assert.equal(await setChatTaskStatus(B1, { id: task.id, status: 'cancelled' }, db), null);

      // Still open and untouched in its own scope.
      assert.equal((await listChatTasks(A1, { includeClosed: true }, db)).length, 1);
      assert.equal((await listChatTasks(A1, {}, db))[0].status, 'pending');
      // Even a correct-scope update addressed by a foreign id (id exists, wrong scope) misses.
      assert.equal(await updateChatTask(A1, { id: other.id, status: 'cancelled' }, db), null);
    } finally {
      await client.close();
    }
  });

  it('survives Clear chat: the list is keyed by (company, agent), not by the thread', async () => {
    const { client, db } = await freshDb();
    try {
      const before = await addChatTask(A1, { title: 'Keep me across Clear', sourceThreadId: 'thread-1' }, db);
      // Clear chat: the assistant pins a NEW Mastra thread for the same (company, agent) scope.
      const after = await addChatTask(A1, { title: 'Added after the Clear', sourceThreadId: 'thread-2' }, db);
      const listed = await listChatTasks(A1, {}, db);
      assert.deepEqual(listed.map((t) => t.id), [before.id, after.id]);
      // The audit column still records WHERE each item was created (both threads coexist).
      assert.equal(listed[0].sourceThreadId, 'thread-1');
      assert.equal(listed[1].sourceThreadId, 'thread-2');
    } finally {
      await client.close();
    }
  });

  it('stores requestedBy + notes verbatim enough to keep an interested-parties list (no notify transport)', async () => {
    const { client, db } = await freshDb();
    try {
      const task = await addChatTask(
        A1,
        {
          title: 'Write the postmortem',
          notes: 'Notify: Ops, QA',
          requestedBy: { userId: 'u1', displayName: 'Derek' },
        },
        db,
      );
      assert.equal(task.requestedByUserId, 'u1');
      assert.equal(task.requestedByDisplayName, 'Derek');
      assert.equal(task.notes, 'Notify: Ops, QA');

      // The request-stamp is overridable (Derek's amendment): "that one's Bob's".
      const moved = await updateChatTask(A1, { id: task.id, requestedBy: { displayName: 'Bob' } }, db);
      assert.equal(moved?.requestedByUserId, null);
      assert.equal(moved?.requestedByDisplayName, 'Bob');

      // A status note is appended to the interested-parties list instead of replacing it.
      const closed = await setChatTaskStatus(A1, { id: task.id, status: 'done', note: 'Posted to the wiki.' }, db);
      assert.equal(closed?.notes, 'Notify: Ops, QA\nPosted to the wiki.');
    } finally {
      await client.close();
    }
  });

  it('caps nothing at the query layer but keeps updateChatTask honest on title/position', async () => {
    const { client, db } = await freshDb();
    try {
      const t = await addChatTask(A1, { title: 'Rename me', position: 7 }, db);
      const renamed = await updateChatTask(A1, { id: t.id, title: 'Renamed', position: 2 }, db);
      assert.equal(renamed?.title, 'Renamed');
      assert.equal(renamed?.position, 2);
      // Unknown ids miss cleanly instead of throwing.
      assert.equal(await updateChatTask(A1, { id: 'nope', status: 'done' }, db), null);
      assert.equal(await setChatTaskStatus(A1, { id: 'nope', status: 'done' }, db), null);
    } finally {
      await client.close();
    }
  });
});

// ─── TASK-RUNNER query layer (B3, PR #196 hold) ──────────────────────────────
// The scheduler poller's DB contract: listRunnable finds pending/unpaused/budgeted rows
// (and carries agent/company status so the poller can skip inactive agents BEFORE claiming),
// claim is a conditional one-shot (pending + unpaused + attempts left), finish only settles
// in_progress rows, and pause/resume is scope-checked.

async function setRunnerAttempts(client: PGlite, id: string, attempts: number): Promise<void> {
  await client.query('update chat_tasks set runner_attempts = $1 where id = $2', [attempts, id]);
}

describe('chat-task runner queries (listRunnable / claim / finish / pause)', () => {
  it('listRunnableChatTasks returns pending, unpaused, budgeted rows in claim order with status columns', async () => {
    const { client, db } = await freshDb();
    try {
      const t1 = await addChatTask(A1, { title: 'First' }, db);
      const t2 = await addChatTask(A1, { title: 'Second', notes: 'ctx' }, db);
      const t3 = await addChatTask(A1, { title: 'Paused one' }, db);
      const t4 = await addChatTask(A1, { title: 'Out of attempts' }, db);
      const running = await addChatTask(A1, { title: 'In progress' }, db);
      const tForeign = await addChatTask(A2, { title: 'Other agent tail' }, db);
      await setChatTaskPaused(A1, { id: t3.id, paused: true }, db);
      await setRunnerAttempts(client, t4.id, 2);
      await setChatTaskStatus(A1, { id: running.id, status: 'in_progress' }, db); // claimed elsewhere

      const listed = await listRunnableChatTasks(db, { maxAttempts: 2 });
      // Claim order: agentId → position → createdAt; paused, attempt-exhausted and
      // non-pending rows are excluded by the query itself.
      assert.deepEqual(listed.map((r) => r.taskId), [t1.id, t2.id, tForeign.id]);
      const first = listed[0]!;
      assert.equal(first.title, 'First');
      assert.equal(first.attempts, 0);
      assert.equal(first.paused, false);
      assert.equal(first.agentName, 'Assistant');
      assert.equal(first.agentUrlKey, 'assistant');
      assert.equal(first.agentStatus, 'active');
      assert.equal(first.companyStatus, 'active');

      // The poller's B1 skip depends on the status columns being real: pause the AGENT and
      // archive its COMPANY and the row still surfaces (caller decides, never the row).
      await client.exec(`update agents set status = 'paused' where id = 'a2'; update companies set status = 'archived' where id = 'c1';`);
      const withInactive = await listRunnableChatTasks(db, { maxAttempts: 2 });
      const foreignRow = withInactive.find((r) => r.taskId === tForeign.id)!;
      assert.equal(foreignRow.agentStatus, 'paused');
      const a1Row = withInactive.find((r) => r.taskId === t1.id)!;
      assert.equal(a1Row.companyStatus, 'archived');
    } finally {
      await client.close();
    }
  });

  it('claimChatTaskRun claims once (pending + unpaused + budget) and burns one attempt per claim', async () => {
    const { client, db } = await freshDb();
    try {
      const pending = await addChatTask(A1, { title: 'Claim me' }, db);
      const claimed = await claimChatTaskRun(db, { taskId: pending.id, runId: 'run-1' });
      assert.equal(claimed?.status, 'in_progress');
      assert.equal(claimed?.runnerAttempts, 1);
      assert.equal(claimed?.runnerLastRunId, 'run-1');

      // A second claim races itself: no longer pending → null, attempts unchanged.
      assert.equal(await claimChatTaskRun(db, { taskId: pending.id, runId: 'run-2' }), null);

      // A paused task never claims (this is the DB-side twin of the poller's paused skip).
      const paused = await addChatTask(A1, { title: 'Paused' }, db);
      await setChatTaskPaused(A1, { id: paused.id, paused: true }, db);
      assert.equal(await claimChatTaskRun(db, { taskId: paused.id, runId: 'run-3' }), null);

      // Attempt budget exhausted → null (the row stays pending for a human, not claimable).
      const spent = await addChatTask(A1, { title: 'Spent' }, db);
      await setRunnerAttempts(client, spent.id, 2);
      assert.equal(await claimChatTaskRun(db, { taskId: spent.id, runId: 'run-4' }), null);
      // ...while a higher budget admits it (maxAttempts is the caller's, not hard-coded).
      const admitted = await claimChatTaskRun(db, { taskId: spent.id, runId: 'run-5', attemptBudget: 3 });
      assert.equal(admitted?.runnerAttempts, 3);

      // Unknown id misses cleanly.
      assert.equal(await claimChatTaskRun(db, { taskId: 'nope', runId: 'run-6' }), null);
    } finally {
      await client.close();
    }
  });

  it('finishChatTaskRun settles ONLY in_progress rows and appends the note', async () => {
    const { client, db } = await freshDb();
    try {
      // A pending task is not "running" — finishing it is a no-op, never a resurrection.
      const pending = await addChatTask(A1, { title: 'Never claimed', notes: 'ctx' }, db);
      assert.equal(await finishChatTaskRun(db, { taskId: pending.id, status: 'done' }), null);

      const claimed = await claimChatTaskRun(db, { taskId: pending.id, runId: 'run-1' });
      assert.ok(claimed);
      const done = await finishChatTaskRun(db, { taskId: pending.id, status: 'done', note: 'Shipped.' });
      assert.equal(done?.status, 'done');
      assert.equal(done?.notes, 'ctx\nShipped.');
      assert.ok(done?.completedAt, 'done stamps completedAt');
      // Settled rows are not re-settleable (a late duplicate finish must not clobber).
      assert.equal(await finishChatTaskRun(db, { taskId: pending.id, status: 'pending' }), null);

      // Retry path on a SEPARATE task (a done row is not claimable again): claim → re-queue
      // to pending, completedAt cleared, note appended.
      const retry = await addChatTask(A1, { title: 'Fail then retry', notes: 'ctx2' }, db);
      const claimed2 = await claimChatTaskRun(db, { taskId: retry.id, runId: 'run-2' });
      assert.equal(claimed2?.status, 'in_progress');
      const requeued = await finishChatTaskRun(db, { taskId: retry.id, status: 'pending', note: 'boom' });
      assert.equal(requeued?.status, 'pending');
      assert.equal(requeued?.completedAt, null);
      assert.equal(requeued?.notes, 'ctx2\nboom');
      // ...and it is claimable once more while the budget lasts (attempt 2 of 2).
      const claimed3 = await claimChatTaskRun(db, { taskId: retry.id, runId: 'run-2b' });
      assert.equal(claimed3?.runnerAttempts, 2);
      assert.equal(await claimChatTaskRun(db, { taskId: retry.id, runId: 'run-2c' }), null); // budget spent
      // A done row is never resurrected by the retry path either.
      assert.equal(await claimChatTaskRun(db, { taskId: pending.id, runId: 'run-2d' }), null);

      // Park path + unknown id.
      const other = await claimChatTaskRun(db, { taskId: (await addChatTask(A1, { title: 'Park me' }, db)).id, runId: 'run-3' });
      assert.equal((await finishChatTaskRun(db, { taskId: other!.id, status: 'waiting_on_user' }))?.status, 'waiting_on_user');
      assert.equal(await finishChatTaskRun(db, { taskId: 'nope', status: 'done' }), null);
    } finally {
      await client.close();
    }
  });

  it('setChatTaskPaused toggles within scope, refuses cross-scope, and gates the runnable list', async () => {
    const { client, db } = await freshDb();
    try {
      const mine = await addChatTask(A1, { title: 'Mine' }, db);
      const theirs = await addChatTask(A2, { title: 'Theirs' }, db);

      // Cross-scope (same company, other agent / other company) is a no-op, not a write.
      assert.equal(await setChatTaskPaused(A2, { id: mine.id, paused: true }, db), null);
      assert.equal(await setChatTaskPaused(B1, { id: mine.id, paused: true }, db), null);
      assert.equal(await setChatTaskPaused(A1, { id: theirs.id, paused: true }, db), null);
      assert.equal((await listChatTasks(A1, {}, db))[0].paused, false, 'foreign pause attempts did not stick');

      // Correct scope pauses, and the task leaves the runnable queue immediately
      // (the other agent's task stays runnable — the pause is per-row, not per-agent).
      const paused = await setChatTaskPaused(A1, { id: mine.id, paused: true }, db);
      assert.equal(paused?.paused, true);
      const whilePaused = (await listRunnableChatTasks(db, {})).map((r) => r.taskId);
      assert.ok(!whilePaused.includes(mine.id), 'paused task left the runnable queue');
      assert.ok(whilePaused.includes(theirs.id), 'the other agent keeps its queue');

      // Resume puts it back.
      const resumed = await setChatTaskPaused(A1, { id: mine.id, paused: false }, db);
      assert.equal(resumed?.paused, false);
      assert.ok((await listRunnableChatTasks(db, {})).map((r) => r.taskId).includes(mine.id));

      // Unknown id misses cleanly.
      assert.equal(await setChatTaskPaused(A1, { id: 'nope', paused: true }, db), null);
    } finally {
      await client.close();
    }
  });
});

// ─── S3 (PR #202 ACCEPT softs): per-company listing caps ─────────────────────
// The scheduler lists Run Task candidates with each company's RESOLVED maxAttemptsPerTask
// (settings.taskRunner.maxAttemptsPerTask, clamped — resolved by the caller, the db layer
// stays settings-blind). Before this, the listing used one fixed bound (5), so a pending row
// whose attempts already spent a LOWERED company budget was listed every tick and refused by
// the claim every tick — permanently.

describe('listRunnableChatTasks per-company caps (S3, PR #202 ACCEPT softs)', () => {
  it('stops listing a pending row whose attempts already spent its own company budget', async () => {
    const { client, db } = await freshDb();
    try {
      await client.query(
        `update companies set settings = '{"taskRunner":{"maxAttemptsPerTask":1}}'::jsonb where id = 'c1'`,
      );
      const over = await addChatTask(A1, { title: 'Over budget' }, db);
      await setRunnerAttempts(client, over.id, 1); // attempts == budget (1) → over budget
      const healthy = await addChatTask(A2, { title: 'Healthy' }, db); // attempts 0 < 1

      const capped = (await listRunnableChatTasks(db, { maxAttemptsByCompany: { c1: 1 } })).map((r) => r.taskId);
      assert.ok(!capped.includes(over.id), 'row at its own company budget must NOT be listed');
      assert.ok(capped.includes(healthy.id), 'a sibling under the same cap still lists (per-row, not per-company starvation)');

      // The CAP is the filter, not the row: the same row lists again under a generous cap.
      const generous = (await listRunnableChatTasks(db, { maxAttemptsByCompany: { c1: 5 } })).map((r) => r.taskId);
      assert.ok(generous.includes(over.id), 'attempts 1 < 5 → runnable again when the company budget allows');

      // The known limitation the map fixes: one fixed bound (the pre-fix 5) still lists it.
      const legacy = (await listRunnableChatTasks(db, { maxAttempts: 5 })).map((r) => r.taskId);
      assert.ok(legacy.includes(over.id), 'fixed maxAttempts=5 still lists over-budget rows (documents the S3 limitation)');

      // CASE is per-company: c1 at cap 1 hides its row even when c2 gets a generous cap.
      const foreign = await addChatTask(B1, { title: 'Foreign at 4' }, db);
      await setRunnerAttempts(client, foreign.id, 4);
      const mixed = await listRunnableChatTasks(db, { maxAttemptsByCompany: { c1: 1, c2: 3 } });
      assert.deepEqual(mixed.map((r) => r.taskId), [healthy.id], 'c2 rows over the c2 cap drop out too');
      const loosened = (await listRunnableChatTasks(db, { maxAttemptsByCompany: { c1: 1, c2: 5 } })).map((r) => r.taskId);
      assert.ok(loosened.includes(foreign.id), 'c2 cap 5 admits the attempts=4 row');
    } finally {
      await client.close();
    }
  });

  it('a company absent from the map falls back to the historic listing bound (5)', async () => {
    const { client, db } = await freshDb();
    try {
      const t = await addChatTask(B1, { title: 'Unknown company row' }, db);
      await setRunnerAttempts(client, t.id, 4); // 4 < 5 → still listed under the fallback bound
      const listed = (await listRunnableChatTasks(db, { maxAttemptsByCompany: { c1: 1 } })).map((r) => r.taskId);
      assert.ok(listed.includes(t.id), 'absent company keeps the pre-fix bound 5 (never starved by the CASE)');
    } finally {
      await client.close();
    }
  });

  it('listPendingChatTaskCompanySettings returns one row per company with pending unpaused work', async () => {
    const { client, db } = await freshDb();
    try {
      await client.query(`update companies set settings = '{"taskRunner":{"maxAttemptsPerTask":1}}'::jsonb where id = 'c1'`);
      await addChatTask(A1, { title: 'Pending c1' }, db);
      await addChatTask(B1, { title: 'Pending c2' }, db);
      const paused = await addChatTask(A2, { title: 'Paused pending' }, db);
      await setChatTaskPaused(A2, { id: paused.id, paused: true }, db);
      await addChatTask(A1, { title: 'Done, not pending', status: 'done' }, db);
      // A company whose only rows are done/cancelled never appears.
      const c3Only = await client.query(
        `insert into companies (id, name, slug, issue_prefix) values ('c3', 'Idle Co', 'idle', 'IC')
         returning id`,
      );
      assert.equal(c3Only.rows.length, 1);
      await client.query(
        `insert into agents (id, company_id, name, role, title, url_key) values ('d1', 'c3', 'Idle Bot', 'engineer', 'E', 'idle-bot')`,
      );
      await addChatTask({ companyId: 'c3', agentId: 'd1' }, { title: 'Already done', status: 'done' }, db);
      // #208 S1: a PAUSED-ONLY company. The paused row above sits in c1 alongside unpaused
      // work, so before this fixture no company tested the paused-only exclusion the assertion
      // message claims — every pending row of c4 is paused, and c4 must never appear.
      await client.query(
        `insert into companies (id, name, slug, issue_prefix) values ('c4', 'Paused Co', 'paused', 'PC')`,
      );
      await client.query(
        `insert into agents (id, company_id, name, role, title, url_key) values ('d2', 'c4', 'Paused Bot', 'engineer', 'E', 'paused-bot')`,
      );
      const pausedOnly = await addChatTask({ companyId: 'c4', agentId: 'd2' }, { title: 'Paused only' }, db);
      await setChatTaskPaused({ companyId: 'c4', agentId: 'd2' }, { id: pausedOnly.id, paused: true }, db);

      const pairs = await listPendingChatTaskCompanySettings(db);
      assert.deepEqual(
        pairs.map((p) => p.companyId).sort(),
        ['c1', 'c2'],
        'exactly the companies with pending unpaused rows (paused-only and done-only companies excluded)',
      );
      assert.ok(
        !pairs.some((p) => p.companyId === 'c4'),
        'c4 is excluded: its only pending rows are PAUSED (the paused=false filter is live)',
      );
      const c1 = pairs.find((p) => p.companyId === 'c1')!;
      assert.deepEqual(c1.companySettings, { taskRunner: { maxAttemptsPerTask: 1 } }, 'raw settings travel for the caller to resolve');
      // Multiple pending rows in one company still yield ONE pair (grouped, not joined to tasks).
      await addChatTask(A1, { title: 'Another pending c1' }, db);
      assert.equal((await listPendingChatTaskCompanySettings(db)).filter((p) => p.companyId === 'c1').length, 1);
    } finally {
      await client.close();
    }
  });
});

function countOpenSafe(list: { status: string }[]): number {
  return list.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'waiting_on_user').length;
}

// ─── S8 / S9 (#196 soft-pack): runnable-list fairness + true front-prioritisation ──

describe('chat-task runner fairness + prioritisation (S8/S9, PR #196 softs)', () => {
  it('S8: a 25+ backlog on one agent does not starve a later agent', async () => {
    const { client, db } = await freshDb();
    try {
      // The old query was ONE global `order by agentId, position, createdAt limit N`: with 30
      // pending rows on a1 and N=25, a2 never appeared. Per-agent fair share fixes that.
      for (let i = 0; i < 30; i++) await addChatTask(A1, { title: `Flood ${i}` }, db);
      const late = await addChatTask(A2, { title: 'Late agent task' }, db);

      const listed = await listRunnableChatTasks(db, { limit: 25 });
      assert.ok(listed.some((r) => r.taskId === late.id), 'agent a2 must appear despite a1 30-row backlog');
      const a1Rows = listed.filter((r) => r.agentId === 'a1');
      const a2Rows = listed.filter((r) => r.agentId === 'a2');
      assert.equal(a2Rows.length, 1);
      // S7 (#205 softs): a1 is no longer capped at its fair share — once every agent has its
      // share, the backfill pass lets the flooded agent use the slots the small agent left
      // idle (slots are gated per agent downstream, so nobody else could borrow them). The
      // STARVATION guarantee still stands: a2 got its only row BEFORE any backfill happened.
      assert.ok(
        a1Rows.length >= Math.ceil(25 / 2),
        `a1 keeps at least its fair share, got ${a1Rows.length}`,
      );
      assert.equal(listed.length, 25, 'the global limit is fully used once every agent got its share (S7)');
      // Claim order INSIDE the flooded agent is unchanged: position, then age.
      assert.deepEqual(a1Rows.map((r) => r.title), a1Rows.map((_, i) => `Flood ${i}`));
    } finally {
      await client.close();
    }
  });

  it('S8: fair shares fill the global limit when both agents have backlog', async () => {
    const { client, db } = await freshDb();
    try {
      for (let i = 0; i < 5; i++) await addChatTask(A1, { title: `A1-${i}` }, db);
      for (let i = 0; i < 5; i++) await addChatTask(A2, { title: `A2-${i}` }, db);
      const listed = await listRunnableChatTasks(db, { limit: 4 });
      assert.equal(listed.length, 4, 'the global limit is saturated from both agents');
      assert.equal(listed.filter((r) => r.agentId === 'a1').length, 2);
      assert.equal(listed.filter((r) => r.agentId === 'a2').length, 2);
    } finally {
      await client.close();
    }
  });

  it('S9: prioritizeChatTask sorts ahead of an older task tied at position 0 (createdAt tiebreak)', async () => {
    const { client, db } = await freshDb();
    try {
      const older = await addChatTask(A1, { title: 'Older at zero' }, db); // position 0, created first
      const mid = await addChatTask(A1, { title: 'Mid' }, db); // position 1
      const target = await addChatTask(A1, { title: 'Prioritise me', position: 2 }, db);

      // Pre-fix, setting position 0 tied the newer task with `older` and the createdAt
      // tiebreak kept `older` first — the "prioritised" task was still claimed last.
      const prio = await prioritizeChatTask(A1, { id: target.id }, db);
      assert.ok(prio);
      assert.ok(prio!.position < 0, `front position must be strictly below every other row, got ${prio!.position}`);
      const listed = await listChatTasks(A1, {}, db);
      assert.equal(listed[0]!.id, target.id, 'the prioritised task sorts first, ahead of the older position-0 row');
      assert.deepEqual(listed.map((t) => t.title).slice(1), ['Older at zero', 'Mid']);

      // Prioritising another task keeps strict ordering (no collision with the current head).
      const again = await prioritizeChatTask(A1, { id: mid.id }, db);
      assert.ok(again!.position < prio!.position);
      assert.equal((await listChatTasks(A1, {}, db))[0]!.id, mid.id);
      // The Run Task claim order follows the same sort: mid leads a1's runnable rows.
      const run = await listRunnableChatTasks(db, {});
      assert.equal(run.find((r) => r.agentId === 'a1')?.taskId, mid.id);

      // Explicit position passes through unchanged; unknown id misses; foreign scope refuses.
      assert.equal((await prioritizeChatTask(A1, { id: older.id, position: 3 }, db))?.position, 3);
      assert.equal(await prioritizeChatTask(A1, { id: 'nope' }, db), null);
      assert.equal(await prioritizeChatTask(A2, { id: target.id }, db), null);
      assert.equal((await listChatTasks(A1, {}, db)).find((t) => t.id === target.id)?.position, -1);
    } finally {
      await client.close();
    }
  });
});

// ─── #208 ACCEPT softs (S2/S3): company-read determinism + one fallback bound ──

/**
 * Record every (sql, params) pair drizzle hands to the driver from here on — the driver-
 * boundary truth for what the company read actually compiles to (same spy shape as
 * chat-task-runner-softs.test.ts, local here so that file stays #205's own).
 */
function spyQueries(client: PGlite): Array<{ sql: string; params: unknown[] }> {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const original = client.query.bind(client);
  (client as unknown as {
    query: (sql: string, params?: unknown[], config?: unknown) => Promise<unknown>;
  }).query = (sqlText: string, params?: unknown[], config?: unknown) => {
    captured.push({ sql: String(sqlText), params: params ?? [] });
    return original(sqlText, params as never[], config as never);
  };
  return captured;
}

describe('chat-task company read + fallback bound (S2/S3, PR #208 ACCEPT softs)', () => {
  it('S2: the company read is ORDERED and grouped on the companies PK — a limit is a stable prefix', async () => {
    const { client, db } = await freshDb();
    try {
      // Four companies with pending unpaused work, seeded OUT of id order so a missing
      // ORDER BY cannot hide behind heap order: 'b9' is the FIRST pending row inserted (heap
      // leader) but must sort second-to-last behind 'a0'.
      await client.exec(`
        insert into companies (id, name, slug, issue_prefix) values
          ('a0', 'Alpha Co', 'alpha', 'AC'),
          ('b9', 'Bravo Co', 'bravo', 'BC');
        insert into agents (id, company_id, name, role, title, url_key) values
          ('e1', 'a0', 'Alpha Bot', 'engineer', 'E', 'alpha-bot'),
          ('e2', 'b9', 'Bravo Bot', 'engineer', 'E', 'bravo-bot');
      `);
      await addChatTask({ companyId: 'b9', agentId: 'e2' }, { title: 'Bravo pending' }, db);
      await addChatTask({ companyId: 'a0', agentId: 'e1' }, { title: 'Alpha pending' }, db);
      await addChatTask(A1, { title: 'C1 pending' }, db);
      await addChatTask(B1, { title: 'C2 pending' }, db);

      const captured = spyQueries(client);
      const pairs = await listPendingChatTaskCompanySettings(db, { limit: 3 });
      // Deterministic LOWEST-ID prefix. Drop the ORDER BY and the limit truncates by scan
      // order instead — b9 sneaks in, a0 falls off the map, and a lowered-budget company
      // silently relists (the exact S2 bug) — this assertion goes RED.
      assert.deepEqual(pairs.map((p) => p.companyId), ['a0', 'b9', 'c1']);

      const companyRead = captured.find(
        (q) => /group by/i.test(q.sql) && q.sql.toLowerCase().includes('inner join "companies"'),
      );
      assert.ok(companyRead, 'the company read actually ran (spy observed the real query)');
      const sqlText = companyRead!.sql.toLowerCase();
      assert.match(sqlText, /order by "companies"\."id"/, 'the read is ORDERED — the limit is a stable prefix (S2)');
      assert.match(sqlText, /group by "companies"\."id"/, 'grouped on the companies PK, not the jsonb settings value');
      assert.doesNotMatch(sqlText, /group by[^]*"settings"/, 'the jsonb settings column never joins the GROUP BY');
    } finally {
      await client.close();
    }
  });

  it('S3: the EMPTY map uses the SAME fallback bound 5 as the CASE ELSE (one fallback)', async () => {
    const { client, db } = await freshDb();
    try {
      // Four rows on a1 with attempts 2..5, listed with NO company map at all (the empty-map
      // branch). Pre-fix the empty map capped at 2 while the CASE ELSE capped at 5: a task
      // inserted between the company read and the listing was judged by the tighter bound —
      // the lowered-budget relisting behaviour returning through the side door.
      const ids: string[] = [];
      for (const attempts of [2, 3, 4, 5]) {
        const t = await addChatTask(A1, { title: `At ${attempts}` }, db);
        await setRunnerAttempts(client, t.id, attempts);
        ids.push(t.id);
      }

      const emptyMap = new Set((await listRunnableChatTasks(db, {})).map((r) => r.taskId));
      assert.ok(emptyMap.has(ids[0]), 'attempts 2 lists — the fallback is 5, not 2');
      assert.ok(emptyMap.has(ids[2]), 'attempts 4 lists under the fallback');
      assert.ok(!emptyMap.has(ids[3]), 'attempts 5 is still over the historic bound 5');

      // Same rows through the OTHER branch (map present, ELSE applies): identical bounds.
      const viaElse = new Set(
        (await listRunnableChatTasks(db, { maxAttemptsByCompany: { c2: 1 } })).map((r) => r.taskId),
      );
      assert.deepEqual(
        [...viaElse].sort(),
        [...emptyMap].sort(),
        'empty-map listing and CASE ELSE agree — one fallback, no drift between the branches',
      );
    } finally {
      await client.close();
    }
  });
});
