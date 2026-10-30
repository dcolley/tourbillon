import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
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
