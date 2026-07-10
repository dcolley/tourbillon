import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string | null;
  environment: 'development' | 'production' | 'test';
}

function readRootPackageVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), '../../package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveGitCommit(): string {
  const fromEnv =
    process.env.TOURBILLON_BUILD_COMMIT?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim()?.slice(0, 7);
  if (fromEnv) return fromEnv;

  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function getBuildInfo(): BuildInfo {
  const version =
    process.env.TOURBILLON_VERSION?.trim() || readRootPackageVersion();
  const builtAt = process.env.TOURBILLON_BUILD_DATE?.trim() || null;
  const nodeEnv = process.env.NODE_ENV;

  return {
    version,
    commit: resolveGitCommit(),
    builtAt,
    environment:
      nodeEnv === 'production'
        ? 'production'
        : nodeEnv === 'test'
          ? 'test'
          : 'development',
  };
}
