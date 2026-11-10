#!/usr/bin/env node
/**
 * #348 — the CI suite for the internal-only Mastra Studio gates.
 *
 * Same discipline as run-harness-tests.mjs (S330-S1 lesson): the CI script is
 * an EXACT command pinned in .github/workflows/ci.yml, the suite is an
 * EXPLICIT file list, and any *.test.ts on disk under lib/mastra-studio/ that
 * is not in the list fails the run LOUD (no silent skips, no globs, no
 * --test-force-exit, no --test-name-pattern).
 *
 * Service-free by design: DATABASE_URL/REDIS_URL default to closed ports so a
 * suite that quietly grows a DB/Redis dependency fails fast here instead of
 * passing on a dev box.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STUDIO_TEST_DIR = 'lib/mastra-studio';

/** The whole Studio suite, explicitly. Keep in lockstep with the dir on disk. */
export const STUDIO_TEST_FILES = [
  'lib/mastra-studio/flag.test.ts',
  'lib/mastra-studio/guard.test.ts',
  'lib/mastra-studio/cors.test.ts',
  'lib/mastra-studio/paths.test.ts',
  'lib/mastra-studio/route.test.ts',
  'lib/mastra-studio/hydration.test.ts',
  'lib/mastra-studio/adapter-smoke.test.ts',
];

function listDirTestFiles() {
  const out = [];
  const dir = join(WEB_ROOT, STUDIO_TEST_DIR);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.test.ts')) out.push(`${STUDIO_TEST_DIR}/${entry.name}`);
  }
  return out.sort();
}

export function listStudioTestFiles() {
  const missing = STUDIO_TEST_FILES.filter((f) => !existsSync(join(WEB_ROOT, f)));
  if (missing.length > 0) {
    throw new Error(`mastra-studio tests: STUDIO_TEST_FILES entries missing on disk: ${missing.join(', ')}`);
  }
  const listed = new Set(STUDIO_TEST_FILES);
  const uncovered = listDirTestFiles().filter((f) => !listed.has(f));
  if (uncovered.length > 0) {
    throw new Error(
      `mastra-studio tests: ${STUDIO_TEST_DIR} test files not in STUDIO_TEST_FILES (add them explicitly): ${uncovered.join(', ')}`,
    );
  }
  return [...STUDIO_TEST_FILES];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let files;
  try {
    files = listStudioTestFiles();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('mastra-studio tests: no test files found');
    process.exit(1);
  }
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://ci:***@127.0.0.1:1/unused',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:1',
  };
  const localTsx = join(WEB_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const tsx = existsSync(localTsx) ? localTsx : 'tsx';
  console.log(`mastra-studio tests: ${files.length} files (${files.join(', ')})`);
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
