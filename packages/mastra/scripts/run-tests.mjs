#!/usr/bin/env node
/**
 * packages/mastra authoritative test counter (S264-S3, Refs #264).
 *
 * Why this exists:
 *   Running the suite with `--test-force-exit` makes Node's test reporter
 *   truncate the trailing TAP summary. The force-exit path calls process.exit
 *   before the asynchronous stdout writes have flushed through the pipe, so
 *   the reported counts silently UNDER-report and the exit code stays 0.
 *   Reproduced on the same tree (2026-10-30, spark-2d3b, full serial run):
 *     no force-exit : # tests 409 / pass 396 / skipped 13   (stable, exits on
 *                     its own in ~70s - no lingering handles today)
 *     force-exit #1 : # tests 389 / pass 376  <- 20 tests vanished, exit 0
 *     force-exit #2 : # tests 409 / pass 396  <- complete, by luck
 *   This is the likely root cause of the suite-count drift flagged by the
 *   #260 / #262 / #264 test gates (S260-S4 / S262-S4 / S264-S3).
 *
 * Rules this encodes:
 *   - NEVER gate the mastra suite on a --test-force-exit run: it is not
 *     needed (the suite exits cleanly) and its counts are unreliable.
 *   - Counts are only reported when the TAP summary block is complete; a
 *     missing/incomplete summary exits non-zero with "COUNTS INCOMPLETE"
 *     instead of printing numbers that could be silently short.
 *
 * Usage:
 *   pnpm --filter @tourbillon/mastra test:counts
 *   pnpm --filter @tourbillon/mastra test:counts -- src/tools/role-tools.test.ts
 *   MASTRA_TEST_TIMEOUT_MS=600000 pnpm --filter @tourbillon/mastra test:counts
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUFFIX = '.test.ts';
const TEST_DIRS = ['src'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(SUFFIX)) out.push(relative(PKG_ROOT, full));
  }
  return out;
}

// Explicit file list, same rationale as apps/web/scripts/run-tests.mjs:
// glob expansion differs across the Node versions engines allows (>=20).
const extra = process.argv.slice(2);
const targets = extra.length > 0 ? extra : TEST_DIRS.flatMap((d) => walk(join(PKG_ROOT, d))).sort();
if (targets.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const tsx = join(PKG_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const timeoutMs = Number(process.env.MASTRA_TEST_TIMEOUT_MS ?? 15 * 60_000);
const result = spawnSync(
  existsSync(tsx) ? tsx : 'tsx',
  ['--conditions=tourbillon-test', '--test', '--test-reporter=tap', ...targets],
  { cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, shell: process.platform === 'win32' },
);

const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(out);

if (result.error) {
  console.error(`COUNTS INCOMPLETE: runner failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.signal || result.status === null) {
  console.error(
    `COUNTS INCOMPLETE: runner killed (${result.signal ?? 'no status'}) after ${timeoutMs}ms - ` +
      'a test is hanging; the counts above, if any, are NOT authoritative.',
  );
  process.exit(1);
}

// Last TAP summary block wins (each subtest prints its own fragments).
const summary = {};
const wanted = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
for (const line of out.split('\n')) {
  const m = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/);
  if (m) summary[m[1]] = Number(m[2]);
}
const missing = wanted.filter((k) => !(k in summary));
if (missing.length > 0) {
  console.error(`COUNTS INCOMPLETE: TAP summary missing ${missing.join(', ')} - do NOT trust these counts.`);
  process.exit(1);
}
if (summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo < summary.tests) {
  console.error('COUNTS INCOMPLETE: summary lines do not add up - do NOT trust these counts.');
  process.exit(1);
}

console.error(
  `COUNTS COMPLETE: tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} ` +
    `skipped=${summary.skipped} cancelled=${summary.cancelled} todo=${summary.todo}`,
);
process.exit(result.status);
