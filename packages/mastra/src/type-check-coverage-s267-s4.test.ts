import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * S267-S4 pin: nothing on origin/main asserted that packages/mastra participates in
 * the root `pnpm -r type-check` gate. Mutant M15 (delete the `type-check` script
 * from packages/mastra/package.json) left root type-check GREEN because `pnpm -r`
 * silently SKIPS packages without the script - coverage disappeared with no signal,
 * not even in CI (.github/workflows/ci.yml only runs `pnpm type-check` at the root).
 *
 * These are source pins (readFileSync + JSON.parse), not spawns: no toolchain is
 * required at test time, so they behave identically on CI's node 22 and developer
 * hosts on 24/26 - no host node major is hard-coded anywhere.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
// src/ -> packages/mastra
const mastraPkgDir = join(here, '..');
// packages/mastra -> repo root
const repoRoot = join(mastraPkgDir, '..', '..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function scriptsOf(pkgPath: string): Record<string, string> {
  const scripts = readJson(pkgPath).scripts;
  assert.ok(scripts && typeof scripts === 'object', `${pkgPath} must define a scripts object`);
  return scripts as Record<string, string>;
}

describe('root type-check covers packages/mastra (S267-S4)', () => {
  it('root package.json type-check is the recursive pnpm -r type-check', () => {
    const scripts = scriptsOf(join(repoRoot, 'package.json'));
    // If this ever becomes non-recursive, per-package scripts can silently drop out
    // of the gate again - update this pin deliberately, never accidentally.
    assert.equal(scripts['type-check'], 'pnpm -r type-check');
  });

  it('mastra declares a type-check script so pnpm -r cannot skip it', () => {
    // M15 (script removed) REDs here: pnpm -r skips packages without the script and
    // the root gate stays GREEN with zero mastra coverage.
    const scripts = scriptsOf(join(mastraPkgDir, 'package.json'));
    assert.equal(typeof scripts['type-check'], 'string', 'packages/mastra must define a type-check script');
    assert.ok(
      scripts['type-check'].includes('type-check-gate.sh'),
      `mastra type-check must route through the baseline gate, got: ${scripts['type-check']}`,
    );
  });

  it('the gate script exists, is wired to tsconfig + baseline, and refuses silent no-run', () => {
    const gatePath = join(mastraPkgDir, 'scripts', 'type-check-gate.sh');
    assert.ok(existsSync(gatePath), 'scripts/type-check-gate.sh must exist (the type-check script points at it)');
    const gate = readFileSync(gatePath, 'utf8');
    // It must type-check the package project, not an ad-hoc file list. Pin the
    // actual invocation line (a header comment mentioning `tsc -p` must not count).
    assert.match(gate, /node\s+\$TSC_ARGS\s+-p\s+tsconfig\.json/, 'gate must run tsc -p tsconfig.json via $TSC_ARGS');
    // It must compare against the committed baseline.
    assert.match(gate, /BASELINE=type-check\.baseline/, 'gate must read type-check.baseline');
    assert.match(gate, /type-check\.baseline/, 'baseline file name must be pinned');
    // S267-S3 companion: a non-zero tsc exit with zero `error TS` lines must fail
    // (kills the missing-tsc + baseline-0 GREEN look, M12/M13) - pin the guard's
    // canonical shape so a revert to the exit-2-only check REDs.
    assert.match(
      gate,
      /if \[ "\$code" -ne 0 \] && \[ "\$actual" -eq 0 \]; then/,
      'gate must fail when tsc exits non-zero with zero error TS diagnostics',
    );
    assert.doesNotMatch(gate, /if \[ "\$code" -eq 2 \] && \[ "\$actual" -eq 0 \]; then/, 'exit-2-only crash check is the M13-surviving shape');
  });

  it('the baseline file is committed with a numeric line', () => {
    const baselinePath = join(mastraPkgDir, 'type-check.baseline');
    assert.ok(existsSync(baselinePath), 'type-check.baseline must be committed (the gate exits 1 without it)');
    const baseline = readFileSync(baselinePath, 'utf8');
    const numeric = baseline.match(/^\d+$/m);
    assert.ok(numeric, 'baseline must carry a numeric error-count line');
    assert.ok(Number(numeric![0]) >= 0);
  });

  it('CI runs the root type-check gate', () => {
    // The pin only matters if CI executes the root script; assert the wiring so a
    // CI job rename/removal is caught too. No node major is asserted - CI pins its
    // own version there and the gate is version-agnostic at test time.
    const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /run: pnpm type-check/, 'CI must run the root type-check');
  });
});

describe('gate behaviour: a non-zero tsc exit must never read as GREEN (S271-S2)', () => {
  // The S267-S3 no-run guard above is pinned by source regex, but a text-only pin
  // is dodgeable: M3 kept the guard line verbatim and inserted an early
  // `exit 0` for any non-zero tsc exit BEFORE it - the regex stayed GREEN while
  // the gate went back to exiting 0 on a missing tsc. These tests copy the LIVE
  // gate script into a scratch tree and actually run it (spawn), so the exit
  // code, not the wording, is the assertion. The copy runs against a scratch
  // tree (its own type-check.baseline, TSC_ARGS re-pointed), so no real tsc is
  // ever invoked - cheap, and identical on any POSIX shell host.
  const gateSrcPath = join(mastraPkgDir, 'scripts', 'type-check-gate.sh');

  function runScratchGate(opts: { tscPath: string; baseline: string; fakeTscSource?: string }): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const scratch = mkdtempSync(join(tmpdir(), `tb-gate-s271-s2-${process.pid}-`));
    try {
      mkdirSync(join(scratch, 'scripts'), { recursive: true });
      const gate = readFileSync(gateSrcPath, 'utf8');
      // Re-point TSC_ARGS at the scratch path (missing file, or the fake tsc).
      // The gate runs `node $TSC_ARGS ...` from its own dir (dirname $0/..), so
      // an absolute scratch path survives the cd.
      const rewritten = gate.replace(/^TSC_ARGS=.*$/m, `TSC_ARGS="${join(scratch, opts.tscPath)}"`);
      assert.ok(rewritten !== gate && !rewritten.includes('../../node_modules/typescript'), 'TSC_ARGS rewrite must land before the gate is run');
      writeFileSync(join(scratch, 'scripts', 'type-check-gate.sh'), rewritten, { mode: 0o755 });
      writeFileSync(join(scratch, 'type-check.baseline'), `${opts.baseline}\n`);
      if (opts.fakeTscSource !== undefined) {
        writeFileSync(join(scratch, opts.tscPath), opts.fakeTscSource);
      }
      // The gate calls bare `node`; make sure it resolves to this test's node.
      const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
      const r = spawnSync('sh', [join(scratch, 'scripts', 'type-check-gate.sh')], { encoding: 'utf8', env, timeout: 30_000 });
      assert.equal(r.error, undefined, `spawning the gate copy failed: ${String(r.error)}`);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('missing tsc + baseline 0 exits non-zero (kills the M3 early-exit bypass)', () => {
    // Exactly the M3 target configuration: node <missing path> exits non-zero
    // (MODULE_NOT_FOUND) with ZERO 'error TS' lines and a 0 baseline. The honest
    // gate fails via the S267-S3 guard; the M3 mutant's early `exit 0` makes
    // this assertion RED even though the guard text is untouched.
    const r = runScratchGate({ tscPath: 'no-such-tsc.js', baseline: '0' });
    assert.notEqual(r.status, 0, `gate went GREEN with a missing tsc and baseline 0: stdout=${r.stdout} stderr=${r.stderr}`);
    // Pin WHICH failure branch fired (the no-run guard), not any exit 1 -
    // missing-baseline and over-baseline paths also exit 1 for other reasons.
    assert.match(r.stderr, /zero 'error TS'/, `expected the zero-diagnostics no-run message, got: ${r.stderr}`);
  });

  it('a real diagnostics run at the baseline count still exits 0 (not an always-fail gate)', () => {
    // Positive control: the assertion above must not be satisfiable by a gate
    // that simply exits 1 unconditionally. A fake tsc exiting 1 WITH one
    // 'error TS' line, against baseline 1, is a legitimate diagnostics run and
    // must reach the OK path.
    const fake = [
      "process.stdout.write('src/example.ts(1,1): error TS2322: fake diagnostic for the gate test\\n');",
      'process.exit(1);',
      '',
    ].join('\n');
    const r = runScratchGate({ tscPath: 'fake-tsc.js', baseline: '1', fakeTscSource: fake });
    assert.equal(r.status, 0, `legitimate baseline run must pass the gate: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /OK \(1\/1/, `expected the OK line, got: ${r.stdout}`);
  });
});
