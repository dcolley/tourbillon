#!/usr/bin/env node
/**
 * apps/web test runner, safe for every Node allowed by engines (>=20).
 *
 * Quoted globs such as 'app/**\/*.test.ts' are expanded by Node's test runner only on
 * Node >= 21; Node 20 takes them literally ("Could not find …"). Unquoted globs depend on the
 * shell (sh has no **). So:
 *   - Node >= 21: pass the glob patterns through and let Node expand them. Explicit paths are
 *     NOT used there, because Node would read them as globs too
 *     (e.g. app/(dashboard)/agent/[urlKey]/x.test.ts matches nothing).
 *   - Node 20: walk the roots here and pass the explicit file list (no glob support there).
 * Extra CLI args are forwarded before the files, e.g. `pnpm test -- --test-force-exit`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIRS = ['app', 'lib', 'components'];
const TEST_FILES = ['proxy.test.ts'];
const SUFFIX = '.test.ts';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(SUFFIX)) out.push(relative(WEB_ROOT, full));
  }
  return out;
}

const dirs = TEST_DIRS.filter((d) => existsSync(join(WEB_ROOT, d)));
const files = TEST_FILES.filter((f) => existsSync(join(WEB_ROOT, f)));
const major = Number(process.versions.node.split('.')[0]);
const targets =
  major >= 21
    ? [...dirs.map((d) => `${d}/**/*${SUFFIX}`), ...files]
    : [...dirs.flatMap((d) => walk(join(WEB_ROOT, d))).sort(), ...files];

const localTsx = join(WEB_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const tsx = existsSync(localTsx) ? localTsx : 'tsx';
const result = spawnSync(tsx, ['--test', ...process.argv.slice(2), ...targets], {
  cwd: WEB_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
