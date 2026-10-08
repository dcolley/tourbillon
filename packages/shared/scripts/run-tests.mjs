#!/usr/bin/env node
/**
 * packages/shared test runner, safe for every Node allowed by engines (>=20).
 *
 * The old script `tsx --test src/**\/*.test.ts` was unquoted, so pnpm's sh (no globstar)
 * expanded it as src/*\/*.test.ts and silently skipped top-level files such as
 * src/wake-message.test.ts. Quoted globs are only expanded by Node's test runner on Node >= 21.
 * So, as in apps/web/scripts/run-tests.mjs:
 *   - Node >= 21: pass the glob through and let Node expand it.
 *   - Node 20: walk src here and pass the explicit, sorted file list.
 * Extra CLI args are forwarded before the files, e.g. `pnpm test -- --test-force-exit`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'src';
const SUFFIX = '.test.ts';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(SUFFIX)) out.push(relative(PKG_ROOT, full));
  }
  return out;
}

/** Test targets for this Node major (exported for src/test-runner.test.ts). */
export function testTargets(major = Number(process.versions.node.split('.')[0])) {
  return major >= 21 ? [`${SRC}/**/*${SUFFIX}`] : walk(join(PKG_ROOT, SRC)).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targets = testTargets();
  const localTsx = join(PKG_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const tsx = existsSync(localTsx) ? localTsx : 'tsx';
  const result = spawnSync(tsx, ['--test', ...process.argv.slice(2), ...targets], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
