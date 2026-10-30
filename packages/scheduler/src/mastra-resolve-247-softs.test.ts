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
 *
 * #251 softs (this pack):
 *   S251-S1 — childResolve no longer owns its own spawnSync: it delegates to spawnChild(),
 *     the ONE spawn site that the NODE_PATH echo test also runs through, so building the
 *     child env as a raw process.env spread flips the echo RED instead of leaving every
 *     test GREEN (the resolve child still lands on the scheduler link while it exists, so
 *     the resolve test alone cannot discriminate the env). Structural wiring pins at the
 *     bottom of this file guard the delegation: one spawn site, env built by childEnv(),
 *     no re-inlined un-stripped spawn inside childResolve.
 *   S251-S2 — the version comparisons use the declared spec after stripping range
 *     prefixes (^, ~, >=, ...), so a range devDep pins its base version instead of
 *     failing with "store entry must be the DECLARED version ^1.78.0" — a store dir name
 *     that can never exist. Still exact equality, deliberately not semver.satisfies.
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
 * The ONE spawn site (S251-S1): every child process in this file — childResolve's resolve
 * probe AND the NODE_PATH-discriminating echo test — spawns through here, so there is
 * exactly one place where the child env is built. Pre-fix childResolve owned its own
 * spawn call and the echo test owned another: swapping childResolve's child env for a
 * raw spread kept every test GREEN (the echo only checked its OWN spawn, and the resolve
 * child still landed on the scheduler link while it exists). With a single shared site,
 * that swap flips the echo RED; the structural wiring pin at the bottom of this file
 * stops a second, un-stripped spawn from being re-inlined into childResolve.
 */
function spawnChild(script: string): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, ['-e', script], { env: childEnv(), encoding: 'utf8' });
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * Resolve a specifier as a fresh `node` child anchored at packages/scheduler/package.json,
 * with NODE_PATH stripped (via childEnv) so the pnpm hoist dir cannot rescue a missing
 * dependency link. Spawns through spawnChild — the same site the echo test exercises
 * (S251-S1); the wiring pin below asserts the delegation.
 */
function childResolve(specifier: string): { status: number | null; stdout: string; stderr: string } {
  const script =
    `process.stdout.write(require('module').createRequire(${JSON.stringify(PKG_JSON)})` +
    `.resolve(${JSON.stringify(specifier)}));`;
  return spawnChild(script);
}

/**
 * S251-S2: normalise a semver SPEC to its bare version before the exact comparisons
 * below. The scheduler devDep is declared exact today ('1.78.0', pinned by S241-S1), but
 * the comparisons are raw string equality: if the devDep ever becomes a range
 * ('^1.78.0'), comparing the store entry against '^1.78.0' REDs misleadingly — no pnpm
 * store dir can be named that. Stripping the range prefix keeps the declared-pin INTENT
 * (installed tree must equal the declared version). Deliberately NOT semver.satisfies:
 * under '^1.78.0' that would wave 1.99.0 through and gut the pin.
 */
function declaredPinVersion(spec: string): string {
  return spec.trim().replace(/^(?:[v=]|>=|<=|>|<|\^|~)?\s*/, '');
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
  // S251-S2: exact equality is kept (NOT semver.satisfies), but against the normalised
  // base version so a range devDep pins its base version instead of RED-ing against a
  // store dir name that can never exist. See declaredPinVersion.
  const pinned = declaredPinVersion(declared as string);
  // Capture stops at `_` because pnpm appends a peer suffix to the store dir name
  // (e.g. `@mastra+core@1.78.0_@grpc+grpc-js@..._<hash>`) — the version is the part before it.
  const versionInPath = (real.match(/[\\/]node_modules[\\/]\.pnpm[\\/]@mastra\+core@(\d[^_/]*)/) ?? [])[1];
  assert.ok(
    versionInPath !== undefined,
    `the scheduler's @mastra/core must resolve into the pnpm store under an @mastra+core@ entry (got ${real})`,
  );
  assert.equal(
    versionInPath,
    pinned,
    `the .pnpm store entry must be the version the devDep declares (${pinned}, declared as '${declared}'), not any version (store path says ${versionInPath})`,
  );
  const installedVersion = (
    JSON.parse(readFileSync(path.join(real, 'package.json'), 'utf8')) as Record<string, unknown>
  ).version;
  assert.equal(
    installedVersion,
    pinned,
    `the realpath'd @mastra/core package.json version must equal the version the scheduler devDep declares (${pinned}, declared as '${declared}') (installed: ${installedVersion})`,
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
  // Guards the guard: prove the child env really carries no NODE_PATH. S250-S1: the strip
  // is single-sourced in childEnv(). S251-S1: the echo now runs through spawnChild — the
  // very spawn site childResolve uses — so this test exercises the load-bearing wiring,
  // not just the builder. Pre-fix each caller owned its own spawn: swapping childResolve's
  // child env for a raw spread (or dropping the strip from the builder it shared) kept
  // this test GREEN because it only ever checked its OWN spawn. The injected
  // /pretend/pnpm-hoist-dir makes the assertion bite: any child env that reaches the
  // child un-stripped makes this test RED. The wiring pin below closes the remaining
  // gap (a second spawn site bypassing spawnChild entirely).
  // withEnv: set/restore so a NODE_PATH present in the host env can never flip the branch.
  const savedNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = '/pretend/pnpm-hoist-dir';
  try {
    const script = 'process.stdout.write(String(process.env.NODE_PATH));';
    const proc = spawnChild(script);
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout, 'undefined', 'child env must have NODE_PATH removed, not merely unset in the parent');
  } finally {
    if (savedNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = savedNodePath;
  }
});

test('S251-S1: childResolve is wired through the single childEnv-built spawn site (structural pin)', () => {
  // The behavioural reroute above covers the SHARED spawn site; it cannot see a second
  // spawn path re-inlined into childResolve — the echo would check its own site while the
  // resolve child quietly kept its own un-stripped env (the S250-S1 self-reference hole in
  // a new costume, and the exact mutant the brief names). Pin the wiring structurally,
  // task-runner-softs style: count the call sites, assert the canonical expressions,
  // doesNotMatch the mutant shapes. (Every regex below is written so it does not match
  // its own literal text in SRC: after `spawnSync`/`env:` the literal carries `\\` or
  // other non-matching characters, not the `(`/`{` the pattern demands.)
  const SRC = readFileSync(path.join(__dirname, 'mastra-resolve-247-softs.test.ts'), 'utf8');

  // Exactly one child-process spawn site in this file: two sites means the echo test and
  // childResolve are checking different child envs again.
  const spawnSites = SRC.match(/\bspawnSync\s*\(/g) ?? [];
  assert.equal(
    spawnSites.length,
    1,
    `this file must keep exactly one spawn call site so the child env is single-sourced (found ${spawnSites.length})`,
  );

  // The single site must build the child env through the strip, never a raw spread.
  const sitePos = SRC.search(/\bspawnSync\s*\(\s*process\.execPath/);
  assert.ok(sitePos !== -1, 'the single spawn site must spawn process.execPath');
  const site = SRC.slice(sitePos, SRC.indexOf('});', sitePos));
  assert.match(site, /env:\s*childEnv\(\)/, 'the single spawn site must pass env: childEnv()');
  assert.doesNotMatch(
    SRC,
    /env:\s*\{\s*\.\.\.process\.env/,
    'no spawn site may build the child env as a raw process.env spread — that is the S251-S1 mutant (childResolve would silently stop stripping NODE_PATH)',
  );

  // childResolve must DELEGATE to the shared site: an inlined spawn there is invisible to
  // the echo test, so behavioural coverage alone cannot close this gap.
  const crStart = SRC.indexOf('function childResolve(');
  const crEnd = SRC.indexOf("test('S247-S1", crStart);
  assert.ok(crStart !== -1 && crEnd > crStart, 'precondition: childResolve is defined above the tests');
  const childResolveBody = SRC.slice(crStart, crEnd);
  assert.match(
    childResolveBody,
    /return\s+spawnChild\(\s*script\s*\)/,
    'childResolve must spawn via spawnChild(script) — the same site the NODE_PATH echo test exercises',
  );
  assert.doesNotMatch(childResolveBody, /spawnSync\s*\(/, 'childResolve must not own a spawn call of its own');
  assert.doesNotMatch(
    childResolveBody,
    /\.\.\.process\.env/,
    'childResolve must not build its own child env from process.env',
  );
});

test('S251-S2: declared-version comparison stays meaningful when the devDep spec carries a range prefix', () => {
  // The manifest declares '@mastra/core' exactly ('1.78.0', pinned by S241-S1) and the
  // materialisation test compares with assert.equal — correct for an exact pin. But a raw
  // compare against the DECLARED STRING fails misleadingly the moment the devDep becomes
  // a range: "the store entry must be the DECLARED version ^1.78.0" can never be true,
  // so a perfectly good 1.78.0 install REDs with an impossible expectation. Normalising
  // the prefix keeps the pin's intent (installed tree === the declared version) and stays
  // EXACT — deliberately not semver.satisfies, which would wave 1.99.0 through '^1.78.0'.
  assert.equal(declaredPinVersion('1.78.0'), '1.78.0', 'an exact spec normalises to itself');
  for (const spec of ['^1.78.0', '~1.78.0', '>=1.78.0', '>1.78.0', '<=1.78.0', '<1.78.0', '=1.78.0', 'v1.78.0', ' ^1.78.0 ']) {
    assert.equal(declaredPinVersion(spec), '1.78.0', `range spec '${spec}' must normalise to its base version`);
  }
  // The live manifest still pins exactly the version the materialisation test expects
  // (that test does the full store/installed comparison; this pins the normalised value).
  const schedulerPkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as Record<string, unknown>;
  const declared = (schedulerPkg.devDependencies as Record<string, unknown>)['@mastra/core'];
  assert.equal(typeof declared, 'string', 'precondition: @mastra/core declared in devDependencies');
  assert.equal(declaredPinVersion(declared as string), '1.78.0', 'the declared pin must normalise to the monorepo-pinned version');
});
