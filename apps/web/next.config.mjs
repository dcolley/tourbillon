import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
