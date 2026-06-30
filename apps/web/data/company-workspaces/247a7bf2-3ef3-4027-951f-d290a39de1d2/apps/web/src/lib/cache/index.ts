/**
 * Tourbillon Cache Module — TOUR-145
 * 
 * Public API for the Redis caching layer.
 * Provides cache keys, client initialization, and middleware functions.
 */

// Core operations
export {
  setCache,
  getCache,
  deleteCache,
  cacheMiddleware,
  invalidateCache,
} from './service';

// Cache key management
export {
  createCacheKey,
  getDashboardKey,
  getGoalsKey,
  getTasksKey,
  getSettingsKey,
  getProjectKey,
  getInvalidatePattern,
  CACHE_TTLS,
  getCacheTTL,
} from './keys';

// Client initialization (singleton)
export { default as getRedisClient } from './client';
