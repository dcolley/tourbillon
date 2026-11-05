#!/usr/bin/env node
/**
 * S330-S1: the service-free web harness suite that CI runs (`pnpm --filter web test:harness`,
 * job `unit-tests` in .github/workflows/ci.yml).
 *
 * Why a runner script instead of a package.json one-liner: a script like
 * `tsx --test lib/harness/*.test.ts lib/chat-send-key.test.ts` can be mutated (drop the file
 * behind `&& echo`, inject `--test-name-pattern=…`) while every text-regex pin on
 * package.json stays GREEN — CI then reports success on a silently shrunken suite (48 of 72).
 * Same failure class as the scheduler's run-unit-tests.mjs (S328-S4), so same fix:
 *   - the CI script is an EXACT command (`node scripts/run-harness-tests.mjs`), pinned;
 *   - the suite is an EXPLICIT file list (no glob, no shell expansion), pinned by
 *     packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts via the exports below;
 *   - a new lib/harness/*.test.ts file that is not added to HARNESS_TEST_FILES fails LOUD
 *     here (drift check) instead of escaping the run.
 *
 * Deliberately NO --test-force-exit and NO --test-name-pattern in the spawn args: force-exit
 * can drop whole files while exiting 0 (the S322-S1 flake class) and a name pattern silently
 * shrinks the run. Extra CLI args are forwarded before the files for local filtering only —
 * ci.yml is pinned to the bare command.
 *
 * DATABASE_URL / REDIS_URL default to a closed port (as in the scheduler runner) so a harness
 * test that quietly starts needing a service fails fast and loud instead of finding a dev box's
 * database. CI's unit-tests job sets the same values at job level.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The whole CI harness suite, explicitly. Files live in two places on purpose:
 * lib/harness/ (callback gate + chat) and lib/chat-send-key.test.ts (S305-S1, outside the
 * harness folder). Adding a file? Also update the pinned list in
 * packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts.
 */
export const HARNESS_TEST_FILES = [
  'lib/chat-send-key.test.ts',
  'lib/harness/callback-chat.test.ts',
  'lib/harness/callback-gate.test.ts',
];

const HARNESS_DIR = 'lib/harness';

/** Every *.test.ts currently on disk under lib/harness/, sorted. */
export function listHarnessDirTestFiles() {
  const out = [];
  const dir = join(WEB_ROOT, HARNESS_DIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.name.endsWith('.test.ts')) out.push(`${HARNESS_DIR}/${entry.name}`);
    }
  }
  return out.sort();
}

/**
 * The files to run, after failing loud on drift: every pinned file must exist, and every
 * *.test.ts on disk under lib/harness/ must be pinned. A mutation that deletes a file from
 * HARNESS_TEST_FILES either hits the ci-coverage pin (exact deepEqual) or, for lib/harness
 * files, this check — never a silent skip.
 */
export function listHarnessTestFiles() {
  const missing = HARNESS_TEST_FILES.filter((f) => !existsSync(join(WEB_ROOT, f)));
  if (missing.length > 0) {
    throw new Error(`web test:harness: HARNESS_TEST_FILES entries missing on disk: ${missing.join(', ')}`);
  }
  const listed = new Set(HARNESS_TEST_FILES);
  const uncovered = listHarnessDirTestFiles().filter((f) => !listed.has(f));
  if (uncovered.length > 0) {
    throw new Error(
      `web test:harness: lib/harness test files not in HARNESS_TEST_FILES (add them explicitly): ${uncovered.join(', ')}`,
    );
  }
  return [...HARNESS_TEST_FILES];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let files;
  try {
    files = listHarnessTestFiles();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('web test:harness: no test files found');
    process.exit(1);
  }
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://ci:***@127.0.0.1:1/unused',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:1',
  };
  const localTsx = join(WEB_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const tsx = existsSync(localTsx) ? localTsx : 'tsx';
  console.log(`web test:harness: ${files.length} files (${files.join(', ')})`);
  const result = spawnSync(tsx, ['--test', ...process.argv.slice(2), ...files], {
    cwd: WEB_ROOT,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
