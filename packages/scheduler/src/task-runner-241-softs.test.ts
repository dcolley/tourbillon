/**
 * #241 softs S241-S1/S241-S3 — scheduler pack.
 *
 * S241-S1: wake-runner.test.ts imports `@mastra/core/observability` but
 *   packages/scheduler/package.json declared no `@mastra/core` — it resolved only via the
 *   pnpm hoist (NODE_PATH=node_modules/.pnpm/node_modules workaround), so a fresh install
 *   died with MODULE_NOT_FOUND. Fixed by declaring `@mastra/core` as a devDependency at the
 *   version the monorepo already pins (packages/mastra). The pin below reads both manifests:
 *   drop the devDep, change its version, or drift it away from packages/mastra's → RED.
 *   (A source-level import exists only in the test file, hence devDependencies.)
 *
 * S241-S3: MAX_POLL_INTERVAL_MS / MAX_POLL_INTERVAL_SEC (#238 S238-S3) were only pinned
 *   BEHAVIOURALLY (a clamped poller must not burst a 2nd tick within 150 ms). That relies on
 *   Node's overflow→1 ms quirk staying quirk-shaped across versions. These are the
 *   deterministic one-liners: the ceilings are literally the int32 boundaries —
 *   MAX_POLL_INTERVAL_MS === 2**31 − 1 and MAX_POLL_INTERVAL_SEC === 2_147_483 — so an
 *   off-by-one in the constants REDs without any timing. The shared heartbeat ceiling
 *   (S241-S2, packages/shared) is pinned to the same whole-seconds value so the two
 *   int32-clamp families cannot drift apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_HEARTBEAT_INTERVAL_SEC } from '@tourbillon/shared';
import { MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_SEC } from './task-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const PKG_ROOT = path.join(__dirname, '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(PKG_ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

function depOf(pkg: Record<string, unknown>, section: 'dependencies' | 'devDependencies', dep: string): unknown {
  return (pkg[section] as Record<string, unknown> | undefined)?.[dep];
}

// ─── S241-S1 — @mastra/core is a DECLARED devDependency of the scheduler ─────

test('S241-S1: scheduler declares @mastra/core as a devDependency (fresh install must resolve wake-runner.test.ts imports)', () => {
  const schedulerPkg = readJson('package.json');
  const declared = depOf(schedulerPkg, 'devDependencies', '@mastra/core');
  assert.equal(
    declared,
    '1.78.0',
    'packages/scheduler must declare @mastra/core in devDependencies at the monorepo-pinned version — wake-runner.test.ts imports @mastra/core/observability and a hoist-only resolution breaks on fresh installs',
  );
  // Same version the mastra package already uses — no invented major, no drift.
  const mastraPkg = JSON.parse(
    readFileSync(path.join(PKG_ROOT, '..', 'mastra', 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(
    declared,
    depOf(mastraPkg, 'dependencies', '@mastra/core'),
    'the scheduler devDep must match the version packages/mastra already pins',
  );
  // The consumer that motivated the declare: if this import vanishes, revisit the devDep.
  const wakeRunnerTestSrc = readFileSync(path.join(__dirname, 'wake-runner.test.ts'), 'utf8');
  assert.match(
    wakeRunnerTestSrc,
    /from '@mastra\/core\/observability'/,
    "wake-runner.test.ts must still import '@mastra/core/observability' (the reason the devDep exists)",
  );
});

// ─── S241-S3 — int32 constant pins (deterministic, no timer behaviour) ───────

test('S241-S3: MAX_POLL_INTERVAL_MS is exactly the int32 timer maximum 2**31 − 1', () => {
  assert.equal(MAX_POLL_INTERVAL_MS, 2 ** 31 - 1);
});

test('S241-S3: MAX_POLL_INTERVAL_SEC is exactly the last whole second whose ×1000 fits int32', () => {
  assert.equal(MAX_POLL_INTERVAL_SEC, 2_147_483);
  assert.equal(MAX_POLL_INTERVAL_SEC, Math.floor(MAX_POLL_INTERVAL_MS / 1000));
  assert.ok(MAX_POLL_INTERVAL_SEC * 1000 <= MAX_POLL_INTERVAL_MS);
  assert.ok((MAX_POLL_INTERVAL_SEC + 1) * 1000 > MAX_POLL_INTERVAL_MS);
});

test('S241-S3: the shared heartbeat ceiling stays aligned with the poller seconds ceiling', () => {
  // S241-S2 defined MAX_HEARTBEAT_INTERVAL_SEC as the same int32-safe whole-seconds bound;
  // the two clamp families (poll ms/sec, heartbeat liveness sec) must never drift apart.
  assert.equal(MAX_HEARTBEAT_INTERVAL_SEC, 2_147_483);
  assert.equal(MAX_HEARTBEAT_INTERVAL_SEC, MAX_POLL_INTERVAL_SEC);
});
