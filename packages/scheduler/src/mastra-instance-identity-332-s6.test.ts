/**
 * S332-S6 — INSTANCE-IDENTITY pin for @mastra/core across packages/mastra and
 * packages/scheduler (origin: #332 gate ACCEPT soft; PR #332 bumped @mastra/* to
 * core 1.81.0 / mcp 2.7.0).
 *
 * What the soft caught: packages/mastra declares zod via catalog: (^4.6.5 -> locked
 * 4.6.5) while packages/scheduler declares NO zod at all. @mastra/core's zod peer is
 * the wide range '^3.25.0 || ^4.0.0', so for the scheduler pnpm auto-satisfied the
 * peer with the then-newest 4.6.7 (first introduced by this PR) while mastra's copy
 * stayed on 4.6.5. pnpm keys peer variants by resolved peer VERSION, so @mastra/core
 * 1.81.0 materialised as TWO physical copies in node_modules/.pnpm (one per zod).
 * On main before #332 they were one copy. S247-S1 (mastra-resolve-247-softs.test.ts)
 * stayed GREEN throughout because it compares the VERSION TOKEN in the store path,
 * not the instance: both copies say 1.81.0, so a version-only check cannot see a
 * peer-split duplicate. That is the gap this file closes — the two workspace
 * consumers must resolve @mastra/core to the SAME realpath'd file, and each physical
 * copy must peer with ONE physical zod.
 *
 * Mechanism mirrors the established seams of mastra-resolve-247-softs.test.ts:
 *   - childEnv(): the ONE child-env builder; the NODE_PATH delete is load-bearing.
 *     Under the .bin shim the pnpm hoist dir is reachable through NODE_PATH, so an
 *     un-stripped child env could resolve BOTH anchors "successfully" through the
 *     hoist and mask a missing package-local link — the #241 failure mode.
 *   - spawnChild(): the ONE spawn site; every child in this file (the two resolve
 *     probes AND the NODE_PATH echo) spawns through it, so swapping the child env
 *     for a raw spread flips the echo RED instead of leaving the resolve children
 *     un-discriminated (S251-S1 lesson). The structural pin at the bottom guards
 *     the delegation against a re-inlined second spawn.
 *
 * Mutation story (the RED the brief demands): with the two-copy tree that #332
 * shipped (scheduler without a zod declaration), tests 1-3 go RED — different
 * realpaths, two zod versions, two store dirs. With the fix (scheduler declaring
 * zod catalog: so both consumers land on the 4.6.5 peer variant) all three GREEN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const PKG_ROOT = path.join(__dirname, '..');
const SCHEDULER_PKG_JSON = path.join(PKG_ROOT, 'package.json');
const MASTRA_PKG_JSON = path.join(PKG_ROOT, '..', 'mastra', 'package.json');
// node_modules/.pnpm lives at the repo root (pnpm hoists the virtual store there).
const PNPM_STORE = path.join(PKG_ROOT, '..', '..', 'node_modules', '.pnpm');

/**
 * The ONE child-env builder (247-file seam): every spawned child goes through here
 * so the NODE_PATH strip is single-sourced. The echo test below asserts on a child
 * spawned through THIS builder with a fake NODE_PATH injected in the parent — a
 * builder that forgot the strip makes the echo RED instead of self-proving GREEN.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

/**
 * The ONE spawn site (247-file seam): both resolve probes AND the NODE_PATH echo
 * spawn through here, so there is exactly one place where the child env is built.
 */
function spawnChild(script: string): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, ['-e', script], { env: childEnv(), encoding: 'utf8' });
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * Child probe: anchor createRequire at the given package.json, resolve the
 * @mastra/core package ENTRY, then resolve 'zod' from that (realpath'd) entry so the
 * zod found is the physical peer sibling of the physical core copy — not whatever a
 * symlink hop or the hoist dir would surface. Returns both realpaths NUL-separated.
 */
function childResolveCoreAndZod(anchorPkgJson: string): {
  status: number | null;
  coreReal: string;
  zodReal: string;
  stderr: string;
} {
  const script =
    `const { createRequire } = require('module');` +
    `const { realpathSync } = require('fs');` +
    `const core = realpathSync(createRequire(${JSON.stringify(anchorPkgJson)}).resolve('@mastra/core'));` +
    `const zod = realpathSync(createRequire(core).resolve('zod'));` +
    `process.stdout.write(JSON.stringify([core, zod]));`;
  const { status, stdout, stderr } = spawnChild(script);
  let coreReal = '';
  let zodReal = '';
  if (status === 0) {
    try {
      [coreReal = '', zodReal = ''] = JSON.parse(stdout) as string[];
    } catch {
      /* malformed probe output surfaces as the path assertions below */
    }
  }
  return { status, coreReal, zodReal, stderr };
}

/**
 * Read the @mastra/core version the scheduler manifest declares and normalise it to a
 * concrete three-part version usable as a store-prefix probe. Deliberately narrow
 * (exact specs only): the manifest FORM is pinned by S241-S1/S254-S2 in
 * mastra-resolve-247-softs.test.ts — if the devDep ever becomes a range, that pair
 * REDs first and this guard is the backstop that refuses to mis-compare here.
 */
function declaredCoreVersion(): string {
  const pkg = JSON.parse(readFileSync(SCHEDULER_PKG_JSON, 'utf8')) as Record<string, unknown>;
  const declared = (pkg.devDependencies as Record<string, unknown>)['@mastra/core'];
  assert.equal(typeof declared, 'string', 'precondition: @mastra/core declared in scheduler devDependencies');
  const base = (declared as string).trim().replace(/^(?:[v=]|>=|<=|\^|~)?\s*/, '');
  assert.match(
    base,
    /^\d+\.\d+\.\d+$/,
    `declaredPinVersion-style guard: spec '${declared}' must be a concrete version for the store-count probe (S241-S1 pins the manifest form)`,
  );
  return base;
}

test('S332-S6: packages/mastra and packages/scheduler resolve @mastra/core to ONE physical copy (instance identity, not just version)', () => {
  const version = declaredCoreVersion();
  const a = childResolveCoreAndZod(SCHEDULER_PKG_JSON);
  assert.equal(a.status, 0, `scheduler-anchored resolve must exit 0; stderr: ${a.stderr}`);
  const b = childResolveCoreAndZod(MASTRA_PKG_JSON);
  assert.equal(b.status, 0, `mastra-anchored resolve must exit 0; stderr: ${b.stderr}`);
  // S247-S1 compares version TOKENS — both peer variants say 1.81.0, so the token
  // check cannot see the split. Instance identity is the discriminating assertion.
  assert.equal(
    a.coreReal,
    b.coreReal,
    'both workspace consumers must resolve @mastra/core to the SAME realpath — ' +
      'two peer variants of the same version are two physical copies (the S332-S6 regression)',
  );
  assert.ok(
    a.coreReal.includes(path.join('.pnpm', `@mastra+core@${version}`)),
    `the shared copy must be the declared version in the pnpm store (@mastra+core@${version}..., got ${a.coreReal})`,
  );
});

test('S332-S6: the two consumers peer with a SINGLE physical zod version', () => {
  // The identity failure mode is a zod split: one physical core copy can only exist
  // while both consumers see the same zod. Assert it on the peer each physical copy
  // ACTUALLY loads (resolved from the realpath'd core entry), not on a manifest guess.
  const a = childResolveCoreAndZod(SCHEDULER_PKG_JSON);
  const b = childResolveCoreAndZod(MASTRA_PKG_JSON);
  assert.equal(a.status, 0, `scheduler-anchored resolve must exit 0; stderr: ${a.stderr}`);
  assert.equal(b.status, 0, `mastra-anchored resolve must exit 0; stderr: ${b.stderr}`);
  const zodVersion = (real: string) => (real.match(/[\\/]\.pnpm[\\/]zod@(\d[^_/]*)/) ?? [])[1];
  const va = zodVersion(a.zodReal);
  const vb = zodVersion(b.zodReal);
  assert.ok(va !== undefined && vb !== undefined, `both zoDs must resolve into the .pnpm store under a zod@ entry (got ${a.zodReal} | ${b.zodReal})`);
  assert.equal(
    va,
    vb,
    `both @mastra/core consumers must peer with ONE physical zod version (scheduler saw ${va}, mastra saw ${vb}) — ` +
      'a split re-forks @mastra/core into a second physical copy (the S332-S6 regression)',
  );
  // Belt: the store-dir token must agree with the realpath'd package.json version
  // (a stale token must not pass the equality above on its own).
  for (const [who, zodReal] of [
    ['scheduler', a.zodReal],
    ['mastra', b.zodReal],
  ] as const) {
    // Anchor on the store layout (.pnpm/zod@X/node_modules/zod/<entry>) rather than
    // the entry file's own directory — zod's CJS entry sits at the package root today,
    // but a future dist/ move must not turn this belt into a spurious ENOENT RED.
    const NM_ZOD = path.join('node_modules', 'zod');
    const anchor = zodReal.lastIndexOf(NM_ZOD);
    assert.ok(anchor !== -1, `zod realpath must live under a node_modules/zod package root (got ${zodReal})`);
    const pkgJson = path.join(zodReal.slice(0, anchor + NM_ZOD.length), 'package.json');
    const installed = (JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>).version;
    assert.equal(
      installed,
      zodVersion(zodReal),
      `${who}: the zod store-dir token must equal the realpath'd package.json version (token ${zodVersion(zodReal)}, package.json ${installed})`,
    );
  }
});

test('S332-S6: node_modules/.pnpm holds exactly one physical @mastra/core copy at the declared version', () => {
  // The realpath equality above pins the two CONSUMERS; this pins the STORE: zero or
  // more-than-one @mastra+core@<declared>* directory means something else split (or
  // evicted) the instance the consumers share. Version-scoped on purpose: a future
  // transient two-version staging during a bump is out of scope for this pin.
  const version = declaredCoreVersion();
  assert.ok(existsSync(PNPM_STORE), `precondition: pnpm virtual store present at ${PNPM_STORE}`);
  const dirs = readdirSync(PNPM_STORE).filter((d) => d.startsWith(`@mastra+core@${version}`));
  assert.equal(
    dirs.length,
    1,
    `exactly one physical @mastra/core@${version} copy may exist in .pnpm (found ${dirs.length}: ${dirs.join(', ')}) — ` +
      'a second copy means a peer (zod) diverged between consumers again',
  );
});

test('S332-S6: the child env is NODE_PATH-discriminating (strip is load-bearing, single-spawn-site seam)', () => {
  // Guards the guard, 247-style: inject a fake hoist dir in the PARENT and prove the
  // child never sees it. If the resolve probes ever stop handing children childEnv()
  // output, both anchors could resolve through the hoist dir and this pin plus the
  // structural pin below are what RED.
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

test('S332-S6: resolve probes are wired through the single childEnv-built spawn site (structural pin)', () => {
  // Textual wiring pins, 247-style: one spawn site, env built by childEnv(), the
  // probe delegates instead of re-inlining a spawn. A trip here on an honest seam
  // refactor means "update the pin deliberately", not "found a bug".
  const SRC = readFileSync(path.join(__dirname, 'mastra-instance-identity-332-s6.test.ts'), 'utf8');

  const spawnSites = SRC.match(/\bspawnSync\s*\(/g) ?? [];
  assert.equal(
    spawnSites.length,
    1,
    `this file must keep exactly one spawn call site so the child env is single-sourced (found ${spawnSites.length})`,
  );

  const sitePos = SRC.search(/\bspawnSync\s*\(\s*process\.execPath/);
  assert.ok(sitePos !== -1, 'the single spawn site must spawn process.execPath');
  const site = SRC.slice(sitePos, SRC.indexOf('});', sitePos));
  assert.match(site, /env:\s*childEnv\(\)/, 'the single spawn site must pass env: childEnv()');
  assert.doesNotMatch(
    SRC,
    /env:\s*\{\s*\.\.\.process\.env/,
    'no spawn site may build the child env as a raw process.env spread — that is the S251-S1 class of mutant (probes would silently stop stripping NODE_PATH)',
  );

  const ceStart = SRC.indexOf('function childEnv(');
  const ceEnd = SRC.indexOf('function spawnChild(', ceStart);
  assert.ok(ceStart !== -1 && ceEnd > ceStart, 'precondition: childEnv is defined above spawnChild');
  const childEnvBody = SRC.slice(ceStart, ceEnd);
  assert.match(childEnvBody, /\{\s*\.\.\.process\.env\s*\}/, 'childEnv must start from a fresh copy of process.env');
  assert.match(
    childEnvBody,
    /delete\s+env\.NODE_PATH/,
    'childEnv must delete NODE_PATH from the copy it returns — without this the hoist dir can rescue a missing link (the #241 failure mode)',
  );

  const crStart = SRC.indexOf('function childResolveCoreAndZod(');
  const crEnd = SRC.indexOf("test('S332-S6", crStart);
  assert.ok(crStart !== -1 && crEnd > crStart, 'precondition: childResolveCoreAndZod is defined above the tests');
  const probeBody = SRC.slice(crStart, crEnd);
  assert.match(
    probeBody,
    /spawnChild\(\s*script\s*\)/,
    'the resolve probe must spawn via spawnChild(script) — the same site the NODE_PATH echo test exercises',
  );
  assert.doesNotMatch(probeBody, /spawnSync\s*\(/, 'the resolve probe must not own a spawn call of its own');
  assert.doesNotMatch(probeBody, /\.\.\.process\.env/, 'the resolve probe must not build its own child env from process.env');
});
