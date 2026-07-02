import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let cachedMonorepoRoot: string | null = null;

function findMonorepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Repository root (directory containing pnpm-workspace.yaml). */
export function getMonorepoRoot(): string {
  if (cachedMonorepoRoot) {
    return cachedMonorepoRoot;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = findMonorepoRoot(moduleDir);
  if (fromModule) {
    cachedMonorepoRoot = fromModule;
    return fromModule;
  }

  const fromCwd = findMonorepoRoot(process.cwd());
  if (fromCwd) {
    cachedMonorepoRoot = fromCwd;
    return fromCwd;
  }

  cachedMonorepoRoot = process.cwd();
  return cachedMonorepoRoot;
}

/**
 * Resolve a data directory path from an env var or default.
 * Relative values are anchored to the monorepo root, not process.cwd().
 */
export function resolveDataPath(envValue: string | undefined, defaultRelative: string): string {
  const trimmed = envValue?.trim();
  if (!trimmed) {
    return path.join(getMonorepoRoot(), defaultRelative);
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  const relative = trimmed.replace(/^\.\//, '');
  return path.join(getMonorepoRoot(), relative);
}
