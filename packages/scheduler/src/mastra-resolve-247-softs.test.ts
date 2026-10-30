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
 *
 * #254 softs (this pack):
 *   S254-S1 — the structural pin only counted the spawn-call TOKEN, so a rewire that kept
 *     the token but dropped the env hand-off (or swapped childEnv for an un-stripped
 *     builder) stayed GREEN. Added: a resolve+echo probe replaying the resolve expression
 *     over the shared spawnChild seam with NODE_PATH injected (env hand-off observable from
 *     the resolve path's side), a body pin on childEnv (fresh spread of process.env + the
 *     NODE_PATH delete), and a strict pin that the spawn options object opens with env set
 *     to exactly the childEnv() call and carries no other env-shaped key.
 *   S254-S2 — the live-manifest assertion ended in the magic literal '1.78.0' (the same
 *     gap S241-S1 caught elsewhere). It now goes through the declared-version path: the
 *     live spec must survive declaredPinVersion and be a concrete three-part version; the
 *     exact monorepo value is pinned ONCE by S241-S1 (manifest + packages/mastra match),
 *     and store/installed equality against the declared spec is pinned by the
 *     materialisation test above.
 *   S254-S3 — declaredPinVersion only stripped a single leading comparator, so '||'
 *     disjunctions, two-token ranges, 'npm:pkg@ver' aliases and 'workspace:'/'catalog:'/
 *     'file:' refs mis-compared (e.g. '<1.78.0 || >=1.80.0' yielded base '1.78.0 ||
 *     >=1.80.0', and a lone leading strip made '<1.78.0' look like a base the spec
 *     excludes). It now resolves only UNAMBIGUOUS single-version specs (including the
 *     alias form npm:pkg@ver) and REFUSES everything else with the spec in the message —
 *     a manifest edited to an unresolvable form fails loudly instead of silently
 *     comparing a malformed token. No semver.satisfies was invented.
 *
 * #259 softs (this pack):
 *   S259-S1 — declaredPinVersion still stripped a lone EXCLUSIVE comparator: '<1.78.0' and
 *     '>1.78.0' normalised to '1.78.0', so the exact-equality comparisons PASSED against a
 *     1.78.0 store although the declared range rules 1.78.0 out (mutants M22/M23 GREEN —
 *     the rest of what S254-S3 set out to close). It now refuses '<x' / '>x' while
 *     inclusive forms ('^ ~ >= <= = v') keep resolving; the two loop entries that pinned
 *     the exclusives GREEN are flipped to assert.throws, and the docstring matches.
 *   S259-S2 — info: the S251-S1 structural pins are deliberately textual; behaviour-
 *     preserving seam refactors (M4b re-inlined spawn, M5 precomputed options variable)
 *     RED on them. A note at the pin says a trip means "update the pin deliberately".
 *   S259-S3 — info: the childEnv body pin is a text-only presence check — M3b (dead-branch
 *     delete) passes its regexes and is caught by the echo tests at runtime. The comment
 *     no longer claims more structural power than the regexes have.
 *   S259-S4 — cosmetic: the S254-S2 live-manifest assertion moved into its own test so its
 *     RED names the right soft, and the single-comparator strip matrix now lives once (in
 *     the S254-S3 test) instead of duplicated loops in S251-S2 and S254-S3.
 *
 * #265 softs (this pack):
 *   S265-S1 — the S259-S1 refusals were pinned only by /exclusive comparator/, which names
 *     the CATEGORY but not the SPEC: a mutant keeping the guard while genericising the
 *     message (dropping the interpolated spec) stayed GREEN. The loop now builds its
 *     matcher from the spec itself — the error must open with `declaredPinVersion: spec
 *     '<spec>'`, so each entry pins its own name.
 *   S265-S2 — after the S259-S1 guard, the strip regex still listed the bare '>'/'<'
 *     alternatives, which the guard makes unreachable (only '>='/'<=' ever reach the
 *     strip). The dead alts are removed and a readFileSync source pin keeps them removed
 *     (re-adding them is behaviour-preserving, so no value assertion could see it).
 *
 * #270 softs (this pack):
 *   S270-S1 — S265-S1 REPLACED the /exclusive comparator/ category pin with the
 *     spec-shape matcher instead of stacking both, so mutant M5 (delete the S259-S1
 *     exclusive guard entirely) was GREEN again: '<1.78.0' then falls through to the
 *     generic "not an unambiguous single version" refusal, whose message ALSO opens with
 *     `declaredPinVersion: spec '<spec>'`, and the loop matcher accepted it. The loop now
 *     asserts BOTH axes — the message must name the spec (S265-S1 matcher) AND must carry
 *     'exclusive comparator' (S259-S1 category, restored as a second assert.throws) — so
 *     a guard deletion REDs on the category axis while honest message rewording that
 *     keeps the category phrase (M2-style) stays free.
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
 * S254-S1: run a resolve+echo probe through the resolve path's spawn seam. childResolve
 * itself JSON.stringifies its specifier (no code-injection seam, by design) so the probe
 * cannot be smuggled through it; instead this replays childResolve's own resolve expression
 * over the SAME spawnChild call childResolve delegates to (delegation pinned structurally
 * below) and additionally echoes NODE_PATH. One child therefore exercises the resolve path's
 * env hand-off end to end: same spawn site, same createRequire anchor, plus the observable
 * the resolve assertions alone cannot see.
 */
function echoResolveEnvViaSharedSeam(specifier: string): { status: number | null; stdout: string; stderr: string } {
  const script =
    `process.stdout.write(require('module').createRequire(${JSON.stringify(PKG_JSON)})` +
    `.resolve(${JSON.stringify(specifier)}) + '|' + String(process.env.NODE_PATH));`;
  return spawnChild(script);
}

/**
 * S251-S2 / S254-S3: normalise a semver SPEC to its bare version before the exact
 * comparisons below. The scheduler devDep is declared exact today, but the comparisons
 * are raw string equality: if the devDep ever becomes a range ('^1.78.0'), comparing the
 * store entry against '^1.78.0' REDs misleadingly — no pnpm store dir can be named that.
 * Stripping the range prefix keeps the declared-pin INTENT (installed tree must equal the
 * declared version). Deliberately NOT semver.satisfies: under '^1.78.0' that would wave
 * 1.99.0 through and gut the pin.
 *
 * S254-S3: a single leading-comparator strip is NOT safe for every npm spec form. The old
 * one-regex strip turned '<1.78.0 || >=1.80.0' into the garbage base '1.78.0 || >=1.80.0'
 * (and, being satisfied by the leading '<', made a spec that EXCLUDES 1.78.0 look like it
 * pinned 1.78.0), while 'npm:pkg@1.78.0' / 'workspace:*' never normalised at all and then
 * mis-compared as literal tokens. Rule now: resolve ONLY unambiguous single-version specs
 * (optionally prefixed by an INCLUSIVE comparator — '^', '~', '>=', '<=', '=', 'v' —
 * optionally an npm: alias carrying a concrete version tail) and REFUSE every other form
 * by throwing with the spec in the message. Refuse beats inventing semver resolution: the
 * materialisation test surfaces the throw as a loud failure naming the spec, instead of a
 * misleading compare.
 *
 * S259-S1: a lone EXCLUSIVE comparator ('<x' / '>x') is not an unambiguous single-version
 * spec either. The S254-S3 strip still accepted it and normalised '<1.78.0' / '>1.78.0'
 * to '1.78.0' — then the exact-equality comparisons PASSED against a 1.78.0 store even
 * though the declared range RULES 1.78.0 OUT (mutants M22/M23 were GREEN). An excluding
 * range pins nothing for an equality check, so it is refused too; inclusive comparators
 * ('^ ~ >= <= = v', whose ranges INCLUDE their base version) keep the S251-S2 behaviour.
 */
function declaredPinVersion(spec: string): string {
  const trimmed = spec.trim();
  if (/^(?:workspace:|catalog:|file:|link:)/.test(trimmed)) {
    throw new Error(
      `declaredPinVersion: spec '${spec}' is a non-registry reference — there is no published version to pin the store entry against; ` +
        `point the devDep at a concrete version (or update this normaliser deliberately) before re-enabling the comparison`,
    );
  }
  let base = trimmed.startsWith('npm:') ? trimmed.slice(4) : trimmed;
  if (trimmed.startsWith('npm:')) {
    // 'npm:pkg@1.2.3' — the pin is the alias's version tail. '@' starting at index 1 so
    // the leading scope '@' of '@scope/pkg' is not mistaken for the version separator.
    const at = base.indexOf('@', 1);
    base = at === -1 ? '' : base.slice(at + 1);
  }
  base = base.trim();
  // S259-S1: a lone exclusive comparator EXCLUDES its own base version — stripping it
  // would hand the exact-equality comparisons the very version the spec rules out, so an
  // excluding range still passed against a store at that version (M22/M23 GREEN).
  // '>=1.78.0' / '<=1.78.0' INCLUDE 1.78.0 and keep the S251-S2 strip; '<1.78.0' /
  // '>1.78.0' (and the same padded with whitespace) must refuse, naming the spec.
  if (/^[<>](?!=)/.test(base)) {
    throw new Error(
      `declaredPinVersion: spec '${spec}' carries an exclusive comparator — '<'/'>' rule the base version OUT, so stripping it to '${base.replace(/^[<>]\s*/, '')}' ` +
        `would let the exact-equality pin PASS against the version the range excludes; declare an exact or inclusive spec (^ ~ >= <= = v) instead`,
    );
  }
  // S265-S2: the bare '>'/'<' alternatives here became UNREACHABLE once the S259-S1 guard
  // above refuses any base starting with a lone exclusive comparator ('>'/'<' not followed
  // by '='), so only '>='/'<=' ever reach this strip. They were pruned; the source pin in
  // the S254-S3 test below keeps them pruned (re-adding them is a dead-code mutant that
  // would re-open the S259-S1 question of what the strip is allowed to swallow).
  base = base.replace(/^(?:[v=]|>=|<=|\^|~)?\s*/, '');
  if (!/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error(
      `declaredPinVersion: spec '${spec}' is not an unambiguous single version (resolved to '${base}') — ` +
        `multi-comparator forms ('||' disjunctions, two-token ranges) and protocol refs have no single base version; ` +
        `refusing beats mis-comparing, so declare an exact or single-comparator version instead`,
    );
  }
  return base;
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

test('S254-S1: the env the resolve path hands its children is childEnv() output (resolve+echo through the shared spawn seam)', () => {
  // The sibling echo above calls spawnChild directly, so it can only ever prove THAT
  // site's env. The brief's mutant — keeping the spawn-call token but rewiring so the
  // resolve children stop receiving the stripped env — left every prior test GREEN: the
  // echo checked its own call, the resolve children still landed on the scheduler link
  // (link-present, so no resolve assertion discriminates env), and the structural pin
  // only counted the token. This echo runs the resolve expression ITSELF (same anchor,
  // same spawnChild seam childResolve delegates to) with NODE_PATH injected in the
  // parent, so any child env reaching the resolve path un-stripped lands here RED.
  const savedNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = '/pretend/pnpm-hoist-dir';
  try {
    const proc = echoResolveEnvViaSharedSeam('@mastra/core/observability');
    assert.equal(proc.status, 0, `resolve+echo child must exit 0; stderr: ${proc.stderr}`);
    const [resolved, nodePathSeen] = proc.stdout.split('|');
    assert.ok(
      resolved.includes(path.join('@mastra', 'core')) && resolved.includes('observab'),
      `precondition: the same child must really perform the resolve (got ${resolved})`,
    );
    assert.equal(
      nodePathSeen,
      'undefined',
      'the resolve path must hand its children the stripped childEnv(), not an inherited or re-spread env',
    );
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

  // S254-S1 (token-only gap): counting the spawn-call token proved the CALL survived, not
  // that the env hand-off survived with it. Assert on the spawn OPTIONS OBJECT, so any env
  // key whose value is not the childEnv() call — a swapped-in builder, a re-spread, a
  // precomputed variable — REDs even while the token count stays 1. The env value is CAPTURED
  // and compared literally (no lookahead, no unanchored \\b that would also hit the
  // encoding key); the whole options object must be just this env hand-off plus the
  // encoding, so a second env-shaped key cannot hide in it.
  //
  // NOTE (S259-S2): these options pins are deliberately STRUCTURAL/textual, not behavioural.
  // Mutants M4b (spawn call re-inlined at the site, still passing the stripped builder) and
  // M5 (the options object hoisted into a precomputed variable that the spawn then passes)
  // behave EXACTLY like the current code yet RED here — intended. The pins trade refactor
  // tolerance for mutant bite, so a harmless seam refactor tripping them reads as "update
  // the pin deliberately", not "found a bug".
  const optsPos = SRC.indexOf('{', SRC.indexOf('process.execPath', sitePos));
  assert.ok(optsPos !== -1, 'the single spawn site must pass an options object');
  const optionsObject = SRC.slice(optsPos, SRC.indexOf('}', optsPos) + 1);
  assert.match(
    optionsObject,
    /^\{\s*env:\s*childEnv\(\)\s*[,}]/,
    'the spawn options object must open with the env key set to the childEnv() call (a token-only pin let a rewire keep the token and drop the hand-off)',
  );
  const envValueMatch = optionsObject.match(/^\{\s*env:\s*([^,}]+)/);
  assert.ok(envValueMatch, 'precondition: the options object carries an env key');
  assert.equal(
    envValueMatch[1].trim(),
    'childEnv()',
    'the spawn options env value must be exactly the childEnv() call — the S254-S1 rewire mutant (keep the token, swap or drop the stripped-env hand-off) lands here',
  );
  assert.doesNotMatch(
    optionsObject.slice(envValueMatch[0].length),
    /\b[a-zA-Z]*[eE]nv\w*\s*:/,
    'no additional env-shaped key may appear in the spawn options object alongside the childEnv() hand-off',
  );

  // S254-S1: the builder must CARRY the strip. A rewire can keep the call at the site and
  // gut the builder (raw copy, missing delete). Be honest about what the two regexes below
  // actually are (S259-S3): a TEXT-ONLY presence check — the fresh-copy spread and the
  // NODE_PATH delete tokens appear in the body — that names WHICH half went missing but
  // cannot see the body's behaviour. Mutants that keep both tokens while changing the
  // semantics around them (e.g. M3b, deleting a dead branch inside the builder) pass this
  // pin; the echo tests are what catch those, at runtime, by observing what the child env
  // actually contains.
  const ceStart = SRC.indexOf('function childEnv(');
  const ceEnd = SRC.indexOf('function spawnChild(', ceStart);
  assert.ok(ceStart !== -1 && ceEnd > ceStart, 'precondition: childEnv is defined above spawnChild');
  const childEnvBody = SRC.slice(ceStart, ceEnd);
  assert.match(
    childEnvBody,
    /\{\s*\.\.\.process\.env\s*\}/,
    'childEnv must start from a fresh copy of process.env (everything the parent has, minus what it strips)',
  );
  assert.match(
    childEnvBody,
    /delete\s+env\.NODE_PATH/,
    'childEnv must delete NODE_PATH from the copy it returns — without this the hoist dir can rescue a missing link (the #241 failure mode)',
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
  // S251-S2's own story: INCLUSIVE range prefixes pin their base version instead of RED-ing
  // against a store-dir name that can never exist. The full single-comparator matrix (every
  // strip/refuse boundary, including the S259-S1 exclusive refusals) lives once in the
  // S254-S3 test — duplicated loops here just made REDs ambiguous (S259-S4).
  for (const spec of ['^1.78.0', '~1.78.0', ' ^1.78.0 ']) {
    assert.equal(declaredPinVersion(spec), '1.78.0', `range prefix '${spec}' must normalise to its base version`);
  }
});

test('S254-S2: the live manifest spec survives declaredPinVersion as a concrete version', () => {
  // (S259-S4: this block used to sit inside the S251-S2 'range prefix' test, so its RED
  // named the wrong soft — it asserts on the LIVE manifest, which is S254-S2's subject.)
  // S254-S2: the live manifest goes through the SAME declared-version path as every
  // other comparison instead of ending in a second magic literal. A hardcoded literal
  // here re-pins the monorepo version a second time: bump the pin and the materialisation
  // test above stays GREEN (it compares store/installed against the DECLARED spec) while
  // this assertion REDs with a stale expectation — the same gap S241-S1 caught elsewhere.
  // The exact value is pinned ONCE, in task-runner-241-softs.test.ts (manifest equals the
  // monorepo pin AND matches packages/mastra's dependency); the store/installed equality
  // against the declared spec is pinned by the materialisation test. What belongs here is
  // that the LIVE spec survives the normaliser and is itself concrete.
  const schedulerPkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as Record<string, unknown>;
  const declared = (schedulerPkg.devDependencies as Record<string, unknown>)['@mastra/core'];
  assert.equal(typeof declared, 'string', 'precondition: @mastra/core declared in devDependencies');
  const livePin = declaredPinVersion(declared as string);
  assert.match(
    livePin,
    /^\d+\.\d+\.\d+$/,
    `the declared spec '${declared}' must survive declaredPinVersion as a concrete three-part version the materialisation test can compare (S254-S2)`,
  );
});

test('S254-S3: declaredPinVersion strips unambiguous specs and refuses the forms it cannot resolve', () => {
  // Pre-fix the ONE-REGEX strip only ever removed a single leading comparator, so the
  // forms below either mis-compared as garbage tokens or, worse, looked resolvable when
  // they were not ('<1.78.0 || >=1.80.0' stripped to '1.78.0 || >=1.80.0'; a leading '<'
  // on its own made an EXCLUDING spec look like a base pin; aliases and workspace refs
  // came back verbatim). The smallest safe change is strip-when-unambiguous / REFUSE
  // otherwise — deliberately no semver.satisfies, which would gut the exact pin.
  //
  // Unambiguous single-version specs keep resolving (S251-S2 behaviour preserved). The
  // full matrix lives HERE, once — the S251-S2 test no longer duplicates it (S259-S4).
  for (const spec of ['^1.78.0', '~1.78.0', '>=1.78.0', '<=1.78.0', '=1.78.0', 'v1.78.0', '1.78.0', ' v1.78.0 ', ' ^1.78.0 ']) {
    assert.equal(declaredPinVersion(spec), '1.78.0', `single-comparator spec '${spec}' must normalise to its base version`);
  }
  // S259-S1: the asymmetric trap the S254-S3 strip still fell into — a lone EXCLUSIVE
  // comparator normalised to its EXCLUDED base ('<1.78.0' / '>1.78.0' -> '1.78.0'), and
  // the exact-equality comparisons then PASSED against a 1.78.0 store although the range
  // rules 1.78.0 out (mutants M22/M23 GREEN). Inclusive comparators include their base
  // and keep the strip; exclusive ones must refuse. These entries used to sit in the
  // strip loops above (duplicated across S251-S2 and S254-S3) pinned GREEN — flipped.
  for (const spec of ['<1.78.0', '>1.78.0', ' <1.78.0 ', '>1.78.0 ']) {
    // S265-S1 + S270-S1 — BOTH refusal axes pinned, stacked (S270-S1):
    // (a) naming: the message must name the spec — S265-S1's matcher built from the
    //     entry itself, so each loop entry pins its own name (kills "guard kept, message
    //     genericised, spec interpolation dropped").
    // (b) category: the refusal must be the S259-S1 EXCLUSIVE guard's, not the generic
    //     single-version fallback's. S265-S1 had swapped (b) out for (a), which left M5
    //     (delete the guard entirely) GREEN: '<1.78.0' then falls through to the generic
    //     "not an unambiguous single version" refusal — whose message ALSO opens with
    //     `declaredPinVersion: spec '<spec>'` — so (a) alone matches it. With (b) here,
    //     a guard deletion REDs ('exclusive comparator' appears only in the guard's
    //     message), while honest rewording that keeps the category phrase stays free.
    const refusesNamingSpec = new RegExp(
      'declaredPinVersion: spec ' + "'" + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'",
    );
    assert.throws(
      () => declaredPinVersion(spec),
      refusesNamingSpec,
      `'${spec}' excludes its base version: stripping it would let an EXCLUDING range pass the exact-equality pin; it must refuse, naming the spec`,
    );
    assert.throws(
      () => declaredPinVersion(spec),
      /exclusive comparator/,
      `'${spec}' must refuse through the S259-S1 exclusive guard, not the generic 'not an unambiguous single version' fallback — deleting the guard (M5) fell the spec through to that fallback, which names the spec but never mentions the excluded range`,
    );
  }
  // S265-S2: the strip regex above must carry ONLY what the S259-S1 guard still lets
  // through. The bare '>'/'<' alternatives were dead code (a lone exclusive comparator
  // throws before the strip runs; only '>='/'<=' survive the guard) — re-adding them is
  // behaviour-preserving, so no value-based assertion can see it. Pin the strip line to
  // its exact source text. (Two backslashes per escape in the literal below: JS source
  // '\\^' is the two chars \ + ^, exactly what the file holds between replace(/ and ,.)
  const SRC_STRIP = readFileSync(path.join(__dirname, 'mastra-resolve-247-softs.test.ts'), 'utf8');
  const stripCallPos = SRC_STRIP.search(/base = base\.replace\(/);
  assert.ok(stripCallPos !== -1, 'precondition: the strip replace call is present in declaredPinVersion');
  const stripCall = SRC_STRIP.slice(stripCallPos, SRC_STRIP.indexOf(');', stripCallPos));
  const expectedStripLine = 'base = base.replace(/^(?:[v=]|>=|<=|\\^|~)?\\s*/, \'\'';
  assert.equal(
    stripCall,
    expectedStripLine,
    'the strip line must stay byte-exact as the pruned /^(?:[v=]|>=|<=| ... )? strip — only the comparators the S259-S1 guard still allows (expectedStripLine spells the current text); the bare \'>\'/\'<\' alts are unreachable dead code (S265-S2). Codepoints on mismatch: sc=[' +
      [...stripCall].map((c) => c.codePointAt(0)).join(',') +
      "] ex=[" +
      [...expectedStripLine].map((c) => c.codePointAt(0)).join(',') +
      ']',
  );
  const deadAlt = '>' + '|' + '<|';
  assert.ok(
    !stripCall.includes(deadAlt),
    `the strip regex must not list bare '>'/'<' alternatives ('${deadAlt}') — the guard refuses lone exclusives before the strip runs, so those alts are unreachable dead code (S265-S2); the strip-line equality above pins it, this names the mutation`,
  );
  // npm: ALIAS form: the spec itself carries the concrete version, so it is unambiguous —
  // strip the alias prefix and package name (scoped name included) down to the tail.
  assert.equal(declaredPinVersion('npm:@mastra/core@1.78.0'), '1.78.0', 'an npm: alias with a version tail resolves to that version');
  assert.equal(declaredPinVersion('npm:other-pkg@2.3.4'), '2.3.4', 'the alias name is irrelevant; the version tail is the pin');
  assert.throws(
    () => declaredPinVersion('npm:other-pkg'),
    /npm:other-pkg/,
    "an npm: alias WITHOUT a version tail has nothing to pin and must refuse with the spec named",
  );
  // DISJUNCTIONS: the base of the first comparator is NOT the pin — the store could be at
  // a version the range excludes and the old strip still compared it GREEN. Must refuse.
  assert.throws(
    () => declaredPinVersion('<1.78.0 || >=1.80.0'),
    /\|\|/,
    "a '||' disjunction has no single base version and must refuse, not mis-compare (pre-fix this returned '1.78.0 || >=1.80.0')",
  );
  assert.throws(
    () => declaredPinVersion('>=1.78.0 <2.0.0'),
    />=/,
    'a two-token intersection range must refuse (pre-fix it returned the garbage base 1.78.0 <2.0.0)',
  );
  // Protocol refs: no published version exists to compare the .pnpm store entry against.
  for (const spec of ['workspace:*', 'workspace:../mastra', 'catalog:default', 'file:../local-pkg', 'link:../local-pkg']) {
    assert.throws(
      () => declaredPinVersion(spec),
      /non-registry reference/,
      `protocol ref '${spec}' must be refused with a clear message, not compared as a literal token`,
    );
  }
  // Garbage fails the same loud way (pre-fix it flowed through as a misleading compare).
  for (const spec of ['*', 'x', 'latest', '', '1.78']) {
    assert.throws(
      () => declaredPinVersion(spec),
      /unambiguous single version/,
      `wildcard/tag spec '${spec}' has no single base version and must refuse`,
    );
  }
  // The refusal is surfaced LOUDLY: the materialisation test calls declaredPinVersion on
  // the live manifest, so a manifest edited to a refused form fails naming the spec
  // instead of silently comparing a malformed token.
  assert.throws(
    () => declaredPinVersion('>=1.78.0 <2.0.0 || 3.0.0'),
    /unambiguous single version/,
    'compound forms refuse with the resolution diagnostic',
  );
});
