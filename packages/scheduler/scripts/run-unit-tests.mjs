#!/usr/bin/env node
/**
 * S328-S4: the Redis/Postgres-free scheduler unit suite that CI runs (`pnpm --filter
 * @tourbillon/scheduler test:unit`, job `unit-tests` in .github/workflows/ci.yml).
 *
 * Every `src/**\/*.test.ts` runs EXCEPT the files on SERVICE_BOUND below, which need a live
 * Redis and/or Postgres (CI has neither). The list is an explicit, reasoned exemption — a new
 * test file is IN the CI subset by default — and is pinned by
 * src/ci-coverage-s316-s4-s328-s4.test.ts (every entry exists, carries a reason, and the list
 * does not grow silently).
 *
 * DATABASE_URL / REDIS_URL default to a closed port (127.0.0.1:1) so a suite that quietly
 * starts needing a service fails fast and loud instead of finding a dev box's database.
 * Bare --conditions=tourbillon-test as in `pnpm test` (see the S24a note), but deliberately NO
 * --test-force-exit: on Spark1 (Node 24) force-exit was seen to drop whole files from a
 * multi-file run while still exiting 0 (shared: 379/398 on one of two runs — the S322-S1 flake
 * class), which in CI would be a silently shrunken suite. Without it the subset exits on its
 * own in seconds; a future open handle shows up as the job's timeout-minutes, not a fake GREEN.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Test files that need live services and therefore stay out of the CI unit job. */
export const SERVICE_BOUND = [
  {
    file: 'src/timeout-runner.test.ts',
    needs: ['redis', 'postgres'],
    why: 'US6 forceKillHeartbeat inserts a heartbeat_runs row and publishes the kill over Redis',
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(relative(PKG_ROOT, full).split('\\').join('/'));
  }
  return out;
}

/** Every scheduler test file, sorted. */
export function listAllTestFiles() {
  return walk(join(PKG_ROOT, 'src')).sort();
}

/** The CI (service-free) subset: all test files minus SERVICE_BOUND. */
export function listUnitTestFiles() {
  const skip = new Set(SERVICE_BOUND.map((s) => s.file));
  return listAllTestFiles().filter((f) => !skip.has(f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = listUnitTestFiles();
  if (files.length === 0) {
    console.error('scheduler test:unit: no test files found');
    process.exit(1);
  }
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://ci:ci@127.0.0.1:1/unused',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:1',
  };
  const localTsx = join(PKG_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const tsx = existsSync(localTsx) ? localTsx : 'tsx';
  console.log(`scheduler test:unit: ${files.length} files (skipping ${SERVICE_BOUND.map((s) => s.file).join(', ')})`);
  const result = spawnSync(
    tsx,
    ['--conditions=tourbillon-test', '--test', ...process.argv.slice(2), ...files],
    { cwd: PKG_ROOT, stdio: 'inherit', env, shell: process.platform === 'win32' },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
