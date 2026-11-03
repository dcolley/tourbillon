/**
 * S324-S3 pin (Refs #324): ROOT-level participation gate for `pnpm -r type-check`.
 *
 * The per-package pins (packages/mastra type-check-coverage-s267-s4.test.ts,
 * packages/scheduler type-check-participation-s315-1.test.ts) only protect the
 * two packages that happened to get a pin. Gate finding M-A showed the class is
 * repo-wide: `pnpm -r type-check` silently SKIPS any package without a
 * `type-check` script — delete the script from apps/web (or any future package)
 * and the root gate stays GREEN with zero coverage and no signal.
 *
 * This file closes the class at the root: EVERY workspace package (globs from
 * pnpm-workspace.yaml) that owns a tsconfig.json — i.e. has TypeScript to
 * check — must declare a `type-check` script, unless it sits on the explicit
 * exemption list below. The list is pinned EMPTY, so an exemption can only
 * happen deliberately: add the package with a comment stating why, and this
 * file's own list-shape assertions keep the escape hatch honest.
 *
 * Source pins only (readFileSync + tiny YAML/JSON reads) — no tsc/pnpm spawn at
 * test time, so they behave identically on CI and dev hosts.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same idiom as the sibling s315-1 pin: src/ -> packages/scheduler -> repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/**
 * Packages with a tsconfig.json that intentionally declare NO type-check script.
 * Every entry MUST carry a reason comment. Pinned to stay EMPTY below — an entry
 * here is a silent-coverage-hole by declaration, so it needs deliberate review.
 */
const TYPE_CHECK_EXEMPTIONS: string[] = [
  // (none — keep it that way)
];

/**
 * Workspace globs, mirrored from pnpm-workspace.yaml `packages:`. A new glob is
 * a deliberate act; the test below pins this list against the YAML so drift is
 * loud rather than a silently-unscanned directory.
 */
const WORKSPACE_GLOBS = ['apps/*', 'packages/*'];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function workspacePackageDirs(): string[] {
  const dirs: string[] = [];
  for (const glob of WORKSPACE_GLOBS) {
    const parent = join(repoRoot, glob.slice(0, glob.lastIndexOf('/')));
    const star = basename(glob);
    assert.equal(star, '*', 'only <dir>/* workspace globs are supported by this pin');
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

function basename(glob: string): string {
  return glob.split('/').pop() as string;
}

describe('root type-check covers EVERY tsconfig package (S324-S3)', () => {
  const pkgDirs = workspacePackageDirs();

  it('the workspace scan actually finds the known packages (guard against a broken glob mirror)', () => {
    // If this set ever shrinks, the coverage assertion below can go vacuously
    // GREEN — pin the floor with the packages that exist on main today.
    const names = pkgDirs.map((d) => d.slice(repoRoot.length + 1));
    for (const must of ['apps/web', 'apps/mobile', 'packages/mastra', 'packages/scheduler', 'packages/db', 'packages/shared']) {
      assert.ok(names.includes(must), `workspace scan must include ${must}, got: ${names.join(', ')}`);
    }
  });

  it('pnpm-workspace.yaml packages: matches the mirrored WORKSPACE_GLOBS', () => {
    const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const start = yaml.indexOf('packages:');
    const rest = yaml.slice(start + 'packages:'.length);
    // Stop at the next top-level key so `- '@mastra/*'` under
    // minimumReleaseAgeExclude can never be mistaken for a workspace glob.
    const block = rest.split(/^\S/m)[0];
    const listed = [...block.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(listed, WORKSPACE_GLOBS, 'WORKSPACE_GLOBS drifted from pnpm-workspace.yaml — update both deliberately');
  });

  it('every workspace package with a tsconfig.json declares a type-check script', () => {
    const holes: string[] = [];
    const unscannable: string[] = [];
    for (const dir of pkgDirs) {
      const rel = dir.slice(repoRoot.length + 1);
      if (TYPE_CHECK_EXEMPTIONS.includes(rel)) continue;
      if (!existsSync(join(dir, 'tsconfig.json'))) continue; // nothing to type-check (db, shared, skills, slugify-cjs)
      const pkg = readJson(join(dir, 'package.json'));
      const scripts = pkg.scripts as Record<string, string> | undefined;
      const script = scripts?.['type-check'];
      if (typeof script !== 'string' || script.trim() === '') holes.push(rel);
    }
    // A directory holding a tsconfig.json but no package.json can never be
    // reached by `pnpm -r` — flag it rather than skip it silently.
    for (const glob of WORKSPACE_GLOBS) {
      const parent = join(repoRoot, glob.slice(0, glob.lastIndexOf('/')));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(parent, entry.name);
        const rel = dir.slice(repoRoot.length + 1);
        if (TYPE_CHECK_EXEMPTIONS.includes(rel)) continue;
        if (existsSync(join(dir, 'tsconfig.json')) && !existsSync(join(dir, 'package.json'))) unscannable.push(rel);
      }
    }
    assert.deepEqual(unscannable, [], `tsconfig packages without package.json are invisible to pnpm -r: ${unscannable.join(', ')}`);
    assert.deepEqual(
      holes,
      [],
      `pnpm -r type-check would SILENTLY SKIP these tsconfig packages (add a type-check script, or a reviewed exemption): ${holes.join(', ') || 'none'}`,
    );
  });

  it('the exemption list is pinned empty and every entry is a real workspace directory', () => {
    assert.deepEqual(TYPE_CHECK_EXEMPTIONS, [], 'the exemption list must stay empty — every tsconfig package participates');
    for (const rel of TYPE_CHECK_EXEMPTIONS) {
      assert.ok(existsSync(join(repoRoot, rel, 'tsconfig.json')), `exempt package ${rel} must actually own a tsconfig.json (stale exemption?)`);
    }
  });

  it('root package.json type-check stays the recursive pnpm -r type-check', () => {
    // Complements the s315-1 pin: if the root script ever stops being
    // recursive, every per-package script silently drops out of the gate.
    const scripts = readJson(join(repoRoot, 'package.json')).scripts as Record<string, string>;
    assert.equal(scripts['type-check'], 'pnpm -r type-check');
  });
});
