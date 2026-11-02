/**
 * #299 S299-S2 pins — @tourbillon/shared must never lean on @tourbillon/db.
 *
 * The db↔shared workspace pair was cyclic (`pnpm install` warned "cyclic workspace
 * dependencies: packages/db, packages/shared"): shared declared a `@tourbillon/db`
 * workspace dependency and imported it — runtime (vault-credentials, not re-exported from
 * the index but still a package-level edge) and type-only (HeartbeatStatus, OAuthTokens).
 * pnpm's cycle warning keys on the declared edge, so the fix had to drop the dependency
 * entirely: the heartbeat status literal tuple/type now lives in ./heartbeat-status, the
 * OAuth token shape in ./vault-types, and vault-credentials moved to @tourbillon/db.
 *
 * Three pins, cheapest first to trip:
 *  1. shared/package.json must not depend on @tourbillon/db in any dependency map —
 *     re-adding it is what re-creates the cycle warning.
 *  2. No file under src/ may reference @tourbillon/db at all. Banning type-only
 *     imports too (stricter than "never runtime-import") is deliberate: with the
 *     package.json dep gone, any quoted type import of the db package would not even
 *     type-check, and a future dev "fixing" that by re-adding the dep is exactly
 *     the fragility this pin exists to make loud.
 *  3. Reachability walk from src/index.ts: every module the index drags in at runtime
 *     is enumerated and asserted db-free — the brief's "shared's index never
 *     runtime-imports @tourbillon/db", with the traversal itself pinned (a specifier
 *     the walker cannot resolve fails loudly instead of silently shrinking the graph).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every static specifier in a module: import/export-from, require(), dynamic import(). */
function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:import|export)\s*\*\s*from\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    // bare side-effect imports: import <quoted-specifier>;
    /^\s*import\s*['"]([^'"]+)['"]/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function walkFrom(entry: string): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = resolveLocal(file, spec);
      if (!target) {
        unresolved.push(`${file} -> ${spec}`);
        continue;
      }
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return { files: [...seen], unresolved };
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const DB_SPECIFIER = '@tourbillon/db';

describe('#299 S299-S2: shared never depends on db', () => {
  it('shared/package.json declares no @tourbillon/db dependency (the pnpm cycle edge)', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(pkg[field] ?? {}, DB_SPECIFIER),
        false,
        `@tourbillon/shared must not list @tourbillon/db under ${field}: that declared edge ` +
          `(with db→shared) is exactly what makes the workspace pair cyclic — 'pnpm install' ` +
          `warns 'cyclic workspace dependencies: packages/db, packages/shared'`,
      );
    }
  });

  it('no file under shared/src references @tourbillon/db in any position', () => {
    const offenders = listTsFiles(SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Specifier positions only (from/require/import), so prose in comments is exempt.
      return specifiersOf(src).some((s) => s === DB_SPECIFIER || s.startsWith(`${DB_SPECIFIER}/`));
    });
    assert.deepEqual(
      offenders,
      [],
      'shared must not import @tourbillon/db (runtime or type-only) — the types moved to ' +
        './heartbeat-status and ./vault-types; vault-credentials moved to @tourbillon/db. ' +
        'Anything genuinely db-shaped belongs on the db side of the boundary.',
    );
  });

  it('the runtime graph reachable from index.ts is db-free (and fully resolvable)', () => {
    const { files, unresolved } = walkFrom(join(SRC, 'index.ts'));
    assert.deepEqual(
      unresolved,
      [],
      'every relative specifier reachable from the index must resolve — an unresolvable ' +
        'specifier would silently shrink the graph this pin walks',
    );
    assert.ok(files.length > 10, `index graph unexpectedly tiny (${files.length} files)`);
    const offenders = files.filter((f) =>
      specifiersOf(readFileSync(f, 'utf8')).some(
        (s) => s === DB_SPECIFIER || s.startsWith(`${DB_SPECIFIER}/`),
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      'a module re-exported from @tourbillon/shared\'s index must never pull in ' +
        '@tourbillon/db at runtime — that import re-opens the db↔shared cycle',
    );
  });
});
