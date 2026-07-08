import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
  transpilePackages: [
    '@tourbillon/db',
    '@tourbillon/shared',
    '@tourbillon/mastra',
    '@mdxeditor/editor',
  ],
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/memory',
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
