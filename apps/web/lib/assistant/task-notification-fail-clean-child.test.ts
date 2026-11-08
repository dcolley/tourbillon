import test from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import {
  assertBoundaryPrerequisites,
  bridgeReset,
  bridgeStart,
  buildFixture,
  tnTeardown,
} from './task-notification-boundary-harness';

test('TN-FAIL-CLEAN-INNER', { timeout: 60_000 }, async () => {
  await assertBoundaryPrerequisites();
  await bridgeReset();
  await bridgeStart();
  const f = await buildFixture({ seedPin: 't2' });
  const admin = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
  try {
    assert.equal(await admin.ping(), 'PONG', 'FAIL-CLEAN child acquired Redis');
    const rows = await f.pool.query('select 1 as ok');
    assert.equal(rows.rows[0]?.ok, 1, 'FAIL-CLEAN child acquired Postgres');
    assert.ok(f.taskId, 'FAIL-CLEAN child inserted fixture rows');
    assert.equal(1, 2, 'deliberate failing control after acquiring PG and Redis');
  } finally {
    await admin.quit().catch(() => {});
    await f.cleanup();
    await tnTeardown();
  }
});
