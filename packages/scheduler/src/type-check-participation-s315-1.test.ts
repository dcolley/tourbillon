/**
 * S315-S1 pin (Refs #315): packages/scheduler must PARTICIPATE in the root
 * `pnpm -r type-check` gate.
 *
 * Until #315-S1, scheduler had a tsconfig but NO `type-check` script — and
 * `pnpm -r type-check` silently SKIPS packages without the script (the exact
 * failure mode the mastra pack pinned in type-check-coverage-s267-s4.test.ts:
 * coverage disappears with no signal, rc 0 stays green, CI only runs the root
 * gate). Mutant M-A here (delete the `type-check` script from
 * packages/scheduler/package.json) left the root gate GREEN with zero scheduler
 * coverage — these pins RED instead.
 *
 * Second regression class pinned: the `rootDir: src` + root tsconfig.base
 * `paths` combination turned every cross-package .ts source into a TS6059
 * (~140 errors — the "any future scheduler rootDir fix" class tracked in
 * tsconfig.base.json). Re-adding rootDir would resurrect it; the scheduler
 * gate's baseline (27, without any TS6059) fails loudly if it returns, and the
 * tsconfig assertion below fails immediately at test time.
 *
 * Source pins only (readFileSync + JSON.parse) — no tsc spawn at test time, so
 * they behave identically on CI and dev hosts, mirroring the mastra pattern.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> packages/scheduler
const schedulerPkgDir = join(here, '..');
// packages/scheduler -> repo root
const repoRoot = join(schedulerPkgDir, '..', '..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function scriptsOf(pkgPath: string): Record<string, string> {
  const scripts = readJson(pkgPath).scripts;
  assert.ok(scripts && typeof scripts === 'object', `${pkgPath} must define a scripts object`);
  return scripts as Record<string, string>;
}

describe('root type-check covers packages/scheduler (S315-S1)', () => {
  it('root package.json type-check is the recursive pnpm -r type-check', () => {
    // If this ever becomes non-recursive, per-package scripts silently drop out
    // of the gate again — update this pin deliberately, never accidentally.
    const scripts = scriptsOf(join(repoRoot, 'package.json'));
    assert.equal(scripts['type-check'], 'pnpm -r type-check');
  });

  it('scheduler declares a type-check script so pnpm -r cannot skip it', () => {
    // M-A (script removed) REDs here: pnpm -r skips packages without the script
    // and the root gate stays GREEN with zero scheduler coverage.
    const scripts = scriptsOf(join(schedulerPkgDir, 'package.json'));
    assert.equal(typeof scripts['type-check'], 'string', 'packages/scheduler must define a type-check script');
    assert.ok(
      scripts['type-check'].includes('type-check-gate.sh'),
      `scheduler type-check must route through the baseline gate, got: ${scripts['type-check']}`,
    );
  });

  it('the gate script exists, is wired to tsconfig + baseline, and refuses silent no-run', () => {
    const gatePath = join(schedulerPkgDir, 'scripts', 'type-check-gate.sh');
    assert.ok(existsSync(gatePath), 'scripts/type-check-gate.sh must exist (the type-check script points at it)');
    const gate = readFileSync(gatePath, 'utf8');
    // Type-check the package project, not an ad-hoc file list. Pin the actual
    // invocation line (a header comment mentioning `tsc -p` must not count).
    assert.match(gate, /node \$TSC_ARGS -p tsconfig\.json/, 'gate must run tsc -p tsconfig.json via $TSC_ARGS');
    assert.match(gate, /BASELINE=type-check\.baseline/, 'gate must read type-check.baseline');
    // S267-S3 companion: a non-zero tsc exit with zero `error TS` lines must
    // fail (kills the missing/crashed-tsc GREEN look); the exit-2-only check is
    // the surviving shape.
    assert.match(
      gate,
      /if \[ "\$code" -ne 0 \] && \[ "\$actual" -eq 0 \]; then/,
      'gate must fail when tsc exits non-zero with zero error TS diagnostics',
    );
    assert.doesNotMatch(
      gate,
      /if \[ "\$code" -eq 2 \] && \[ "\$actual" -eq 0 \]; then/,
      'exit-2-only crash check is the M13-surviving shape (mastra #267)',
    );
  });

  it('the baseline file is committed with a numeric line', () => {
    const baselinePath = join(schedulerPkgDir, 'type-check.baseline');
    assert.ok(existsSync(baselinePath), 'type-check.baseline must be committed (the gate exits 1 without it)');
    const baseline = readFileSync(baselinePath, 'utf8');
    const numeric = baseline.match(/^\d+$/m);
    assert.ok(numeric, 'type-check.baseline must carry a bare numeric line (the gate parses the last one)');
    assert.ok(Number(numeric![0]) >= 0, 'baseline must be a non-negative count');
  });

  it('scheduler tsconfig keeps noEmit and stays rootDir-free (TS6059 class guard)', () => {
    const tsconfig = readJson(join(schedulerPkgDir, 'tsconfig.json'));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    assert.equal(compilerOptions.noEmit, true, 'scheduler gate is type-check-only (noEmit)');
    // `rootDir: src` + tsconfig.base paths resurrect the ~140-error TS6059
    // cross-package class the gate baseline (27, zero TS6059) cannot tolerate.
    assert.equal(
      compilerOptions.rootDir,
      undefined,
      'scheduler tsconfig must not reintroduce rootDir (workspace packages export raw .ts; see type-check.baseline header)',
    );
  });
});
