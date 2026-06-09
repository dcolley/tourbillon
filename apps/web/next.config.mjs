/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@tourbillon/db', '@tourbillon/shared', '@tourbillon/mastra'],
  serverExternalPackages: ['@mastra/core', '@mastra/memory', 'bullmq', 'ioredis'],
};

export default nextConfig;
