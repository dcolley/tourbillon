/**
 * S316-S4 / S322-S4 + S328-S4 pins (Soft Pack H): CI actually LINTS shared + scheduler and
 * actually RUNS the service-free shared / scheduler / apps/web harness unit tests
 * (plus lib/chat-send-key.test.ts — S305-S1, which sits outside lib/harness/).
 *
 * Before this pack, shared and scheduler had no eslint config (so `pnpm -r lint` skipped them
 * and hermes-adapter / opencode-adapter / wake-runner were never linted), and CI was
 * type-check only. Both gaps are "silent GREEN" failures: delete a lint script, a config, or a
 * CI step and nothing goes red. These pins make each of those deletions red.
 *
 * Source pins (readFileSync) plus ESLint's in-process config resolver — no pnpm/eslint spawn,
 * so they behave identically on CI and dev hosts. This file is itself in the CI unit subset.
 *
 * S330-S1 (Soft Pack I): the web `test:harness` check used to be a text regex on package.json,
 * which stayed GREEN while CI actually ran a shrunken suite (`&& echo`-dropped file, injected
 * `--test-name-pattern`). It now pins the exact runner command plus the runner's explicit file
 * list (imported from apps/web/scripts/run-harness-tests.mjs) and the lib/harness drift guard.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

const here = dirname(fileURLToPath(import.meta.url));
const schedulerRoot = join(here, '..');
const repoRoot = join(schedulerRoot, '..', '..');
const sharedRoot = join(repoRoot, 'packages', 'shared');
const webRoot = join(repoRoot, 'apps', 'web');
const ciPath = join(repoRoot, '.github', 'workflows', 'ci.yml');

function scripts(pkgDir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/** `run:` commands of one top-level job in ci.yml (indentation-based; no YAML dependency). */
function jobBlock(yaml: string, job: string): string | null {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // next job / next top-level key
    out.push(line);
  }
  return out.join('\n');
}

function runs(block: string): string[] {
  return [...block.matchAll(/^\s*-\s+run:\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

type ServiceBound = { file: string; needs: string[]; why: string };
async function unitRunner(): Promise<{
  SERVICE_BOUND: ServiceBound[];
  listAllTestFiles: () => string[];
  listUnitTestFiles: () => string[];
}> {
  // Dynamic import through a URL so tsc does not try to type the .mjs (no allowJs here).
  return (await import(pathToFileURL(join(schedulerRoot, 'scripts', 'run-unit-tests.mjs')).href)) as never;
}

describe('S316-S4 / S322-S4: shared + scheduler are linted (locally and in CI)', () => {
  for (const [name, dir] of [
    ['@tourbillon/shared', sharedRoot],
    ['@tourbillon/scheduler', schedulerRoot],
  ] as const) {
    it(`${name} owns an eslint flat config and a lint script (pnpm -r lint must not skip it)`, () => {
      assert.ok(existsSync(join(dir, 'eslint.config.mjs')), `${name}: eslint.config.mjs missing`);
      assert.match(scripts(dir).lint ?? '', /^eslint \.(\s|$)/, `${name}: "lint" must be "eslint ." over the whole package`);
      assert.match(scripts(dir).lint ?? '', /--max-warnings 0/, `${name}: lint keeps warnings at zero`);
    });
  }

  it('the harness adapters + wake-runner resolve to a real (non-ignored) eslint config', async () => {
    const targets: Array<[string, string[]]> = [
      [schedulerRoot, ['src/adapters/hermes-adapter.ts', 'src/adapters/opencode-adapter.ts', 'src/adapters/harness-adapter.ts', 'src/wake-runner.ts', 'src/harness-session-drive.ts']],
      [sharedRoot, ['src/hermes-harness.ts', 'src/opencode-harness.ts', 'src/harness-chat.ts']],
    ];
    for (const [cwd, files] of targets) {
      const eslint = new ESLint({ cwd });
      for (const file of files) {
        assert.ok(existsSync(join(cwd, file)), `${file} moved — update this pin`);
        assert.equal(await eslint.isPathIgnored(file), false, `${file} must not be eslint-ignored`);
        const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> } | undefined;
        assert.ok(config?.rules?.['@typescript-eslint/no-explicit-any'], `${file}: typescript-eslint rules must apply`);
      }
    }
  });

  it('CI runs both lint scripts', () => {
    const ciRuns = runs(readFileSync(ciPath, 'utf8'));
    for (const name of ['@tourbillon/shared', '@tourbillon/scheduler']) {
      assert.ok(ciRuns.includes(`pnpm --filter ${name} lint`), `ci.yml must run \`pnpm --filter ${name} lint\``);
    }
  });
});

describe('S328-S4: CI runs the service-free shared + scheduler + harness unit tests', () => {
  it('ci.yml has a unit-tests job running all three suites, with no service containers', () => {
    const yaml = readFileSync(ciPath, 'utf8');
    const block = jobBlock(yaml, 'unit-tests');
    assert.ok(block, 'ci.yml must define a top-level `unit-tests` job');
    const jobRuns = runs(block);
    for (const cmd of [
      'pnpm install --frozen-lockfile',
      'pnpm --filter @tourbillon/shared test:unit',
      'pnpm --filter @tourbillon/scheduler test:unit',
      'pnpm --filter web test:harness',
    ]) {
      assert.ok(jobRuns.includes(cmd), `unit-tests job must run \`${cmd}\`, got: ${jobRuns.join(' | ')}`);
    }
    assert.doesNotMatch(block, /^\s+services:/m, 'the unit job is service-free by definition (no postgres/redis containers)');
    assert.match(block, /DATABASE_URL:\s*\S*127\.0\.0\.1:1\//, 'DATABASE_URL points at a closed port');
    assert.match(block, /REDIS_URL:\s*redis:\/\/127\.0\.0\.1:1\b/, 'REDIS_URL points at a closed port');
  });

  it('the package scripts the job calls exist and cover the whole suite', () => {
    assert.match(scripts(sharedRoot)['test:unit'] ?? '', /find src -name \\?"\*\.test\.ts\\?"/, 'shared test:unit runs every src test file');
    assert.equal(scripts(schedulerRoot)['test:unit'], 'node scripts/run-unit-tests.mjs');
    // S330-S1: the web harness script is pinned EXACTLY, not by text regex. Before this, the
    // pin matched substrings of the one-liner, so `… && echo lib/chat-send-key.test.ts` (file
    // never run, 48 of 72 tests) and `--test-name-pattern=PIN` (~29 tests) both stayed GREEN.
    // The suite now lives in an explicit file list inside apps/web/scripts/run-harness-tests.mjs;
    // any text change to the CI command goes red here, and any file-list change goes red below.
    assert.equal(
      scripts(webRoot)['test:harness'],
      'node scripts/run-harness-tests.mjs',
      'web test:harness must be exactly the pinned runner invocation (S330-S1)',
    );
  });

  it('web test:harness runs an explicit, pinned file list — not a text-regex on package.json (S330-S1)', async () => {
    const webRunner = (await import(
      pathToFileURL(join(webRoot, 'scripts', 'run-harness-tests.mjs')).href
    )) as {
      HARNESS_TEST_FILES: string[];
      listHarnessDirTestFiles: () => string[];
      listHarnessTestFiles: () => string[];
    };
    // The exact suite. Dropping a file here (or in the runner) is RED — including
    // lib/chat-send-key.test.ts, which sits outside lib/harness/ (S305-S1) and was the file
    // the old text pin let CI skip.
    assert.deepEqual(
      [...webRunner.HARNESS_TEST_FILES].sort(),
      [
        'lib/chat-send-key.test.ts',
        'lib/harness/callback-chat.test.ts',
        'lib/harness/callback-gate.test.ts',
      ],
      'web harness suite is exactly these files — add/remove deliberately, in both places',
    );
    for (const f of webRunner.HARNESS_TEST_FILES) {
      assert.ok(existsSync(join(webRoot, f)), `${f} no longer exists — update the harness pin`);
    }
    // Drift guard: every *.test.ts on disk under lib/harness/ is in the explicit list, so a
    // new harness file can never escape the CI run by omission (the runner throws too).
    const dirFiles = webRunner.listHarnessDirTestFiles();
    const listed = new Set(webRunner.HARNESS_TEST_FILES);
    for (const f of dirFiles) {
      assert.ok(listed.has(f), `a lib/harness test file is on disk but not in HARNESS_TEST_FILES: ${f}`);
    }
    assert.ok(dirFiles.length >= 2, `only ${dirFiles.length} harness test files on disk — folder moved?`);
    assert.deepEqual(webRunner.listHarnessTestFiles().sort(), [...webRunner.HARNESS_TEST_FILES].sort());
  });

  it('no --test-force-exit / --test-name-pattern in the CI unit scripts (they shrink the run and still exit 0)', () => {
    const webRunnerSrc = readFileSync(join(webRoot, 'scripts', 'run-harness-tests.mjs'), 'utf8');
    for (const [where, cmd] of [
      ['shared test:unit', scripts(sharedRoot)['test:unit'] ?? ''],
      ['web test:harness', scripts(webRoot)['test:harness'] ?? ''],
      ['scheduler run-unit-tests.mjs spawn args', /spawnSync\([\s\S]*?\);/.exec(readFileSync(join(schedulerRoot, 'scripts', 'run-unit-tests.mjs'), 'utf8'))?.[0] ?? ''],
      ['web run-harness-tests.mjs spawn args', /spawnSync\([\s\S]*?\}\);/.exec(webRunnerSrc)?.[0] ?? ''],
    ]) {
      assert.ok(cmd.length > 0, `${where}: not found`);
      assert.doesNotMatch(cmd, /--test-force-exit/, `${where} must not pass --test-force-exit`);
      // S330-S1: a hardcoded name pattern silently runs a subset (the H3 escape: pin GREEN,
      // ~29 of 72 tests). Local filtering stays available via forwarded CLI args in ci.yml's
      // pinned-bare command only.
      assert.doesNotMatch(cmd, /--test-name-pattern/, `${where} must not hardcode --test-name-pattern`);
    }
    assert.match(jobBlock(readFileSync(ciPath, 'utf8'), 'unit-tests') ?? '', /^\s+timeout-minutes:\s*\d+/m, 'the unit job carries a timeout instead');
  });

  it('SERVICE_BOUND is the explicit, reasoned exemption list — and stays exactly this', async () => {
    const { SERVICE_BOUND, listAllTestFiles, listUnitTestFiles } = await unitRunner();
    // Growing this list removes a suite from CI: do it deliberately, with a reason, here too.
    assert.deepEqual(SERVICE_BOUND.map((s) => s.file), ['src/timeout-runner.test.ts']);
    for (const s of SERVICE_BOUND) {
      assert.ok(existsSync(join(schedulerRoot, s.file)), `${s.file} no longer exists — drop it from SERVICE_BOUND`);
      assert.ok(s.needs.length > 0 && s.why.length > 10, `${s.file} needs a reason`);
    }
    const all = listAllTestFiles();
    const unit = listUnitTestFiles();
    assert.equal(unit.length, all.length - SERVICE_BOUND.length, 'only SERVICE_BOUND files are skipped');
    assert.ok(all.length >= 40, `scan found ${all.length} files — broken walk would make the job vacuous`);
    for (const must of [
      'src/ci-coverage-s316-s4-s328-s4.test.ts',
      'src/hermes-adapter.test.ts',
      'src/opencode-adapter.test.ts',
      'src/wake-runner.test.ts',
      'src/wake-runner-hermes.test.ts',
      'src/wake-runner-opencode.test.ts',
      'src/harness-session-drive.test.ts',
    ]) {
      assert.ok(unit.includes(must), `${must} must be in the CI unit subset`);
    }
    assert.ok(!unit.includes('src/timeout-runner.test.ts'));
  });
});

describe('S326-S1: company-computer stays a leaf package (no @tourbillon/* workspace deps)', () => {
  // #326 review: re-adding cc→mastra while @tourbillon/mastra→cc exists forms a workspace
  // CYCLE, and CI only caught it via ERR_PNPM_OUTDATED_LOCKFILE — a regenerated lockfile would
  // sail through with just pnpm's `WARN cyclic workspace dependencies`. The S282-S4 fix moved
  // the shared toolset into @tourbillon/mastra and removed BOTH declared edges, so
  // company-computer is now a leaf: it imports nothing from the workspace. Pinning that (the
  // fix the #326 review asked for) makes any cc-side cycle edge RED on the package.json edit
  // itself, lockfile state or no. One side missing is enough to break the ring — this is the
  // side cc controls. (cc's own test suite is NOT in the CI unit-tests job, so the pin lives
  // here, where CI runs.)
  const ccRoot = join(repoRoot, 'packages', 'company-computer');
  it('package.json declares no @tourbillon/* dependencies (leaf — breaks any cc-side cycle)', () => {
    const pkg = JSON.parse(readFileSync(join(ccRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const offenders = Object.keys(pkg[field] ?? {}).filter((name) => name.startsWith('@tourbillon/'));
      assert.deepEqual(
        offenders,
        [],
        `company-computer must stay a leaf: ${field} pulled in ${offenders.join(', ')} — re-closing the S326 cycle with @tourbillon/mastra`,
      );
    }
  });
});
