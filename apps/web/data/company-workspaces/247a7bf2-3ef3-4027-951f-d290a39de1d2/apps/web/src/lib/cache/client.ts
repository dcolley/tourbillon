/**
 * Tourbillon Redis Cache Client — TOUR-145
 * 
 * Singleton @upstash/redis client for Next.js applications.
 * Uses Upstash Redis (serverless) which is ideal for Vercel deployments.
 * Falls back gracefully if REDIS_URL is not configured.
 */

import { Redis } from '@upstash/redis';

interface CacheConfig {
  url: string;
  token: string;
}

const globalForRedis = globalThis as unknown as {
  redisClient: Redis | undefined;
};

/**
 * Get or create the Redis client singleton.
 */
export function getRedisClient(): Redis | null {
  const config: CacheConfig = {
    url: process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  };

  if (!config.url || !config.token) {
    // Graceful degradation — cache disabled in development without Redis URL
    return null;
  }

  if (globalForRedis.redisClient) {
    return globalForRedis.redisClient;
  }

  try {
    const client = new Redis({
      url: config.url,
      token: config.token,
      // Retry configuration for transient network errors
      automaticDeserialization: true,
    });

    // Test connection in development
    if (process.env.NODE_ENV === 'development') {
      try {
        client.ping();
        console.log('✅ Redis cache connected successfully');
      } catch (error) {
        console.warn('⚠️  Redis ping failed, caching disabled:', error);
        return null;
      }
    }

    globalForRedis.redisClient = client;
    return client;
  } catch (error) {
    console.error('❌ Failed to initialize Redis cache client:', error);
    return null;
  }
}

export default getRedisClient;
