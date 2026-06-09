import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@paperclip-mastra/db', '@paperclip-mastra/shared', '@paperclip-mastra/mastra'],
  experimental: {
    serverComponentsExternalPackages: ['@mastra/core', '@mastra/memory', 'bullmq', 'ioredis'],
  },
};

export default nextConfig;
