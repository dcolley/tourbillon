import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

const allowedDevOrigins = [
  '100.118.152.28',
  ...(process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [])
];
const uniqueAllowedDevOrigins = [...new Set(allowedDevOrigins)];

function resolveGitCommit() {
  if (process.env.TOURBILLON_BUILD_COMMIT?.trim()) {
    return process.env.TOURBILLON_BUILD_COMMIT.trim();
  }
  if (process.env.VERCEL_GIT_COMMIT_SHA?.trim()) {
    return process.env.VERCEL_GIT_COMMIT_SHA.trim().slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    TOURBILLON_BUILD_COMMIT: resolveGitCommit(),
    TOURBILLON_BUILD_DATE: process.env.TOURBILLON_BUILD_DATE ?? new Date().toISOString(),
  },
  allowedDevOrigins: uniqueAllowedDevOrigins,
  transpilePackages: [
    '@tourbillon/db',
    '@tourbillon/shared',
    '@tourbillon/mastra',
    '@mdxeditor/editor',
  ],
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/memory',
    '@mastra/mcp',
    'bullmq',
    'ioredis',
    'drizzle-orm',
    'postgres',
    '@bull-board/api',
    '@bull-board/ui',
    '@bull-board/hono',
    'hono',
  ],
};

export default nextConfig;
