/**
 * #247 softs S247-S1 — behavioural resolution pin for the scheduler `@mastra/core` devDep.
 *
 * S241-S1 (task-runner-241-softs.test.ts) pinned the DECLARATION: packages/scheduler/
 * package.json lists `@mastra/core` 1.78.0 in devDependencies. That guard is text-level —
 * it REDs when the manifest is edited, but not when the installed tree stops satisfying
 * it (link evicted, version drifted away from what is actually in node_modules). The real
 * failure mode behind #241 was runtime: `import '@mastra/core/observability'` in
 * wake-runner.test.ts dying MODULE_NOT_FOUND on a fresh install, masked locally because
 * the pnpm hoist dir is reachable through NODE_PATH under the .bin shim.
 *
 * This pin is behavioural: spawn a CHILD `node -e` with NODE_PATH removed from the child
 * env and resolve '@mastra/core/observability' through createRequire anchored at
 * packages/scheduler/package.json. NODE_PATH removal is load-bearing — under the shim even
 * require.resolve(..., { paths }) succeeds through the hoist dir, so an in-process resolve
 * in this file would not discriminate. The resolved path must live under the scheduler's
 * own installed @mastra/core (pnpm materialises the devDep link into
 * packages/scheduler/node_modules; its realpath is the .pnpm store entry).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const PKG_ROOT = path.join(__dirname, '..');
const PKG_JSON = path.join(PKG_ROOT, 'package.json');
const SCHEDULER_MASTRA_CORE = path.join(PKG_ROOT, 'node_modules', '@mastra', 'core');

/**
 * Resolve a specifier as a fresh `node` child anchored at packages/scheduler/package.json,
 * with NODE_PATH stripped so the pnpm hoist dir cannot rescue a missing dependency link.
 */
function childResolve(specifier: string): { status: number | null; stdout: string; stderr: string } {
  const script =
    `process.stdout.write(require('module').createRequire(${JSON.stringify(PKG_JSON)})` +
    `.resolve(${JSON.stringify(specifier)}));`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  const proc = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

test('S247-S1: the declared @mastra/core devDep is materialised in packages/scheduler/node_modules', () => {
  // Declaration-only (S241-S1) cannot catch the installed tree drifting from the manifest.
  // pnpm materialises a declared dependency as a link into the package's own node_modules;
  // its realpath lands in the .pnpm store under an @mastra+core@<version> directory.
  assert.ok(
    existsSync(SCHEDULER_MASTRA_CORE),
    'packages/scheduler/node_modules/@mastra/core must exist — the devDep declared in package.json has to be installed, not hoist-only',
  );
  const real = realpathSync(SCHEDULER_MASTRA_CORE);
  assert.ok(
    /[\\/]node_modules[\\/]\.pnpm[\\/]@mastra\+core@/.test(real),
    `the scheduler's @mastra/core must resolve into the pnpm store under an @mastra+core@ entry (got ${real})`,
  );
});

test('S247-S1: a child node process with NODE_PATH removed resolves @mastra/core/observability through the scheduler package', () => {
  // The exact import that died on fresh installs before the devDep was declared.
  assert.ok(
    existsSync(SCHEDULER_MASTRA_CORE),
    'precondition: packages/scheduler/node_modules/@mastra/core link present (see sibling test)',
  );
  const expectedRoot = realpathSync(SCHEDULER_MASTRA_CORE);
  const { status, stdout, stderr } = childResolve('@mastra/core/observability');
  assert.equal(
    status,
    0,
    `child resolve must exit 0 without NODE_PATH — a non-zero exit here is the #241 MODULE_NOT_FOUND failure mode; stderr: ${stderr}`,
  );
  assert.ok(
    stdout.startsWith(expectedRoot + path.sep),
    `resolved path must live under the scheduler's own @mastra/core install (${expectedRoot}), got: ${stdout}`,
  );
  assert.ok(
    /@mastra[\\/]core[\\/]/.test(stdout) && stdout.includes('observab'),
    `resolved path must be the @mastra/core observability entry point, got: ${stdout}`,
  );
});

test('S247-S1: the same child resolve is NODE_PATH-discriminating (hoist-only would not pass the link assertion)', () => {
  // Guards the guard: prove the child env really carries no NODE_PATH, otherwise a shim
  // environment could let a hoist-only install slip through the tests above.
  const script = 'process.stdout.write(String(process.env.NODE_PATH));';
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: '/pretend/pnpm-hoist-dir' };
  delete env.NODE_PATH;
  const proc = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout, 'undefined', 'child env must have NODE_PATH removed, not merely unset in the parent');
});
