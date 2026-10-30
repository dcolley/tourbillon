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
 *
 * #250 softs (this pack):
 *   S250-S1 — the discriminating test now spawns through the SAME childEnv() builder as
 *     childResolve (single-sourced strip), so removing the strip makes the child path RED
 *     instead of leaving the self-referential env check GREEN.
 *   S250-S2 — the store pin asserts the realpath'd package.json version EQUALS the declared
 *     scheduler devDependency, not that an `@mastra+core@` dir merely exists (fake 9.9.9
 *     used to pass test 1).
 *   S250-S3 — info: the strip and the `startsWith` assertions are defence-in-depth against
 *     different failure modes (see childEnv docstring); a parent-side `env -u NODE_PATH`
 *     does nothing under the npx tsx shim, so the strip has to live here, in the child env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const PKG_ROOT = path.join(__dirname, '..');
const PKG_JSON = path.join(PKG_ROOT, 'package.json');
const SCHEDULER_MASTRA_CORE = path.join(PKG_ROOT, 'node_modules', '@mastra', 'core');

/**
 * The ONE child-env builder (S250-S1): every spawned child goes through here so the
 * NODE_PATH strip is single-sourced. The NODE_PATH-discriminating test below asserts on a
 * child spawned through THIS builder — if it built its own env object it would only be
 * checking itself, and deleting the strip below would keep that test GREEN.
 *
 * S250-S3: the strip here and the realpath-prefixed `startsWith` assertions in the resolve
 * test are defence-in-depth around different failure modes — the strip stops the pnpm hoist
 * dir from RESCUING a missing scheduler-local link (the #241 failure mode); `startsWith`
 * stops a resolve that lands somewhere else legitimate (store drift, hoisted duplicate).
 * Neither alone is sufficient, so do not prune either one.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

/**
 * Resolve a specifier as a fresh `node` child anchored at packages/scheduler/package.json,
 * with NODE_PATH stripped (via childEnv) so the pnpm hoist dir cannot rescue a missing
 * dependency link.
 */
function childResolve(specifier: string): { status: number | null; stdout: string; stderr: string } {
  const script =
    `process.stdout.write(require('module').createRequire(${JSON.stringify(PKG_JSON)})` +
    `.resolve(${JSON.stringify(specifier)}));`;
  const proc = spawnSync(process.execPath, ['-e', script], { env: childEnv(), encoding: 'utf8' });
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
  // S250-S2: pin the DECLARED version, not "any version". Read the scheduler devDep from
  // package.json (currently 1.78.0) — never hardcode a stale major here. A bare
  // `/@mastra\+core@/` accepted a fake store entry (9.9.9 passed this test pre-fix; only
  // the sibling test noticed), so the store directory AND the installed package.json
  // version must both equal the declared devDep.
  const schedulerPkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as Record<string, unknown>;
  const declared = (schedulerPkg.devDependencies as Record<string, unknown>)['@mastra/core'];
  assert.equal(
    typeof declared,
    'string',
    'precondition: packages/scheduler declares @mastra/core in devDependencies (S241-S1 pins the exact value)',
  );
  // Capture stops at `_` because pnpm appends a peer suffix to the store dir name
  // (e.g. `@mastra+core@1.78.0_@grpc+grpc-js@..._<hash>`) — the version is the part before it.
  const versionInPath = (real.match(/[\\/]node_modules[\\/]\.pnpm[\\/]@mastra\+core@(\d[^_/]*)/) ?? [])[1];
  assert.ok(
    versionInPath !== undefined,
    `the scheduler's @mastra/core must resolve into the pnpm store under an @mastra+core@ entry (got ${real})`,
  );
  assert.equal(
    versionInPath,
    declared,
    `the .pnpm store entry must be the DECLARED version ${declared}, not any version (store path says ${versionInPath})`,
  );
  const installedVersion = (
    JSON.parse(readFileSync(path.join(real, 'package.json'), 'utf8')) as Record<string, unknown>
  ).version;
  assert.equal(
    installedVersion,
    declared,
    `the realpath'd @mastra/core package.json version must equal the declared scheduler devDep ${declared} (installed: ${installedVersion})`,
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
  // Guards the guard: prove the child env really carries no NODE_PATH. S250-S1: the child
  // is spawned through the SAME childEnv() builder as childResolve, so this test now
  // exercises the load-bearing strip. Pre-fix it built its own env object, i.e. it only
  // checked itself — deleting the strip from childResolve kept it GREEN. The injected
  // /pretend/pnpm-hoist-dir makes the assertion bite: if anyone drops the `delete` in
  // childEnv(), the child inherits it and this test goes RED.
  // withEnv: set/restore so a NODE_PATH present in the host env can never flip the branch.
  const savedNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = '/pretend/pnpm-hoist-dir';
  try {
    const script = 'process.stdout.write(String(process.env.NODE_PATH));';
    const proc = spawnSync(process.execPath, ['-e', script], { env: childEnv(), encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout, 'undefined', 'child env must have NODE_PATH removed, not merely unset in the parent');
  } finally {
    if (savedNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = savedNodePath;
  }
});
