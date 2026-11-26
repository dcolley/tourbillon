#!/usr/bin/env node
/**
 * TB-363: the service-free @tourbillon/mastra notice tests CI runs
 * (`pnpm --filter @tourbillon/mastra test:tb363`, job `unit-tests` in .github/workflows/ci.yml).
 *
 * Same pattern as apps/web/scripts/run-harness-tests.mjs (S330-S1): the CI script is an EXACT
 * pinned command, the suite is an EXPLICIT file list (no glob — a glob plus a mutated script can
 * silently shrink the run), and every listed file must exist on disk or the runner fails LOUD.
 * The exact list is pinned by packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts, which
 * CI itself runs. These files carry the A2/A11a/S2/S3/A10-R3 mutant kills (Test verdict MUST-3:
 * kills must come from tests CI actually runs).
 *
 * Deliberately NO --test-force-exit and NO --test-name-pattern in the spawn args (they can drop
 * whole files or shrink the run while exiting 0). Extra CLI args are forwarded before the files
 * for LOCAL filtering only — ci.yml is pinned to the bare command.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MASTRA_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The whole TB-363 mastra CI suite, explicitly. Adding a file? Also update the pinned list in
 * packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts.
 */
export const TB363_TEST_FILES = [
  'src/concierge-signal-tb363.test.ts', // A2 payload (ask + reply-here), 300-char clamp, publisher once
  'src/tools/chat-task-tools-tb363.test.ts', // A11a tool-path emit + exactly-once, S2 silent publisher, S3 warn, A10-R3
];

/** Fail loud on drift: every pinned file must exist (the content of the list itself is pinned in scheduler ci-coverage). */
export function listTb363TestFiles() {
  const missing = TB363_TEST_FILES.filter((f) => !existsSync(join(MASTRA_ROOT, f)));
  if (missing.length > 0) {
    throw new Error(`mastra test:tb363: TB363_TEST_FILES entries missing on disk: ${missing.join(', ')}`);
  }
  if (TB363_TEST_FILES.length < 2) {
    throw new Error(`mastra test:tb363: expected at least ${2} files, got ${TB363_TEST_FILES.length} — list shrunken?`);
  }
  return [...TB363_TEST_FILES];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let files;
  try {
    files = listTb363TestFiles();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const env = {
    ...process.env,
    // Service-free by definition: quietly-needed services fail fast on a closed port.
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://ci:***@127.0.0.1:1/unused',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:1',
  };
  const localTsx = join(MASTRA_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const tsx = existsSync(localTsx) ? localTsx : 'tsx';
  console.log(`mastra test:tb363: ${files.length} files (${files.join(', ')})`);
  const result = spawnSync(tsx, ['--test', ...process.argv.slice(2), ...files], {
    cwd: MASTRA_ROOT,
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
