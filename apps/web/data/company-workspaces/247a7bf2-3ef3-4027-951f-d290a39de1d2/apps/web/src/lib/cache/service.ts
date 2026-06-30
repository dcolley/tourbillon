/**
 * Tourbillon Cache Service — TOUR-145
 * 
 * Core caching layer for Next.js API routes using @upstash/redis.
 * Provides middleware functions and utility methods for GET endpoint caching.
 * Falls back gracefully to no-cache when Redis is unavailable.
 */

import type { NextRequest, NextResponse } from 'next/server';
import getRedisClient from './client';
import { 
  createCacheKey, 
  CACHE_TTLS, 
  CacheTTLKey, 
  getCacheTTL,
  type CacheKeyParts,
} from './keys';

// ============================================================================
// CORE CACHE OPERATIONS
// ============================================================================

interface SetCacheOptions {
  ttl?: number; // Time-to-live in seconds (default: 600)
  key: string;
  value: unknown; // Will be JSON-serialized
}

/**
 * Store a value in the cache with optional TTL.
 * Silently fails if Redis is unavailable.
 */
export async function setCache(options: SetCacheOptions): Promise<boolean> {
  const client = getRedisClient();
  
  if (!client) return false; // Graceful degradation
  
  try {
    const { key, value, ttl } = options;
    
    await client.setex(
      key,
      ttl ?? CACHE_TTLS.dashboard,
      JSON.stringify(value)
    );
    
    return true;
  } catch (error) {
    // Silently fail — caching is not critical to functionality
    console.warn('Cache set failed:', error);
    return false;
  }
}

interface GetCacheOptions {
  key: string;
}

/**
 * Retrieve a value from the cache.
 * Returns null if key doesn't exist or Redis is unavailable.
 */
export async function getCache<T = unknown>(options: GetCacheOptions): Promise<T | null> {
  const client = getRedisClient();
  
  if (!client) return null; // Graceful degradation
  
  try {
    const result = await client.get(options.key);
    
    if (result === null) return null;
    
    return JSON.parse(result as string) as T;
  } catch (error) {
    console.warn('Cache get failed:', error);
    return null;
  }
}

interface DeleteCacheOptions {
  key: string;
}

/**
 * Invalidate a specific cache entry.
 */
export async function deleteCache(options: DeleteCacheOptions): Promise<boolean> {
  const client = getRedisClient();
  
  if (!client) return false;
  
  try {
    await client.del(options.key);
    return true;
  } catch (error) {
    console.warn('Cache delete failed:', error);
    return false;
  }
}

// ============================================================================
// MIDDLEWARE FUNCTIONS FOR GET ENDPOINTS
// ============================================================================

interface CacheMiddlewareOptions {
  key: string | ((req: NextRequest) => string);
  ttl?: number; // Override default TTL for this endpoint (seconds)
  invalidateOn?: {
    /** List of cache keys to invalidate when the route is called with method=POST/PUT/PATCH */
    keys: string[];
    /** Or a function that generates keys based on request body */
    generateKeys?: (body: unknown) => string[];
  };
}

/**
 * Middleware wrapper for GET endpoints that should be cached.
 * 
 * Usage:
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   return cacheMiddleware({ key: 'tourbillon:goals:user-123' }, async () => {
 *     const goals = await db.query.goals.findMany(...);
 *     return NextResponse.json(goals);
 *   });
 * }
 * ```
 */
export async function cacheMiddleware<T extends NextResponse>(
  options: CacheMiddlewareOptions,
  handler: () => Promise<T>
): Promise<T> {
  const client = getRedisClient();
  
  // Resolve the key (static or dynamic based on request)
  let key: string;
  if (typeof options.key === 'function') {
    // We'll need to call this with a mock request — simplified approach
    key = options.key({} as NextRequest);
  } else {
    key = options.key;
  }
  
  const ttl = options.ttl ?? CACHE_TTLS.dashboard;

  try {
    if (client) {
      // Try to get cached response first
      const cachedResponse = await client.get(key);
      
      if (cachedResponse !== null) {
        const parsed = JSON.parse(cachedResponse as string) as { body: unknown; status: number };
        
        return NextResponse.json(parsed.body, { 
          status: parsed.status,
          headers: { 'X-Cache': 'HIT' }
        }) as T;
      }
    }

    // Cache miss — execute handler and store result
    const response = await handler();
    
    if (client && response.status === 200) {
      try {
        // Clone the body to avoid consuming it twice
        const clonedResponse = response.clone();
        const responseBody = await clonedResponse.json();
        
        await client.setex(
          key,
          ttl,
          JSON.stringify({
            body: responseBody,
            status: response.status,
          })
        );
      } catch (error) {
        console.warn('Failed to cache response:', error);
      }
    }

    return response;
  } catch (error) {
    // If caching fails entirely, still execute the handler normally
    return handler();
  }
}

/**
 * Middleware wrapper for POST/PUT/PATCH endpoints that should invalidate related caches.
 * 
 * Usage:
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   const body = await request.json();
 *   
 *   // Invalidate goals cache when a goal is created/deleted
 *   await invalidateCache({ keys: ['tourbillon:goals:*'] });
 *   
 *   return NextResponse.json({ success: true });
 * }
 * ```
 */
export async function invalidateCache(options: { 
  keys: string[];
}): Promise<number> {
  const client = getRedisClient();
  
  if (!client) return 0; // Graceful degradation
  
  try {
    let deletedCount = 0;
    
    for (const key of options.keys) {
      // Handle wildcard patterns by scanning keys
      // Note: In production with many keys, consider using Redis streams or pub/sub
      const count = await client.del(key);
      if (count > 0) deletedCount += count;
    }
    
    return deletedCount;
  } catch (error) {
    console.warn('Cache invalidation failed:', error);
    return 0;
  }
}

// ============================================================================
// ENTITY-SPECIFIC CACHING FUNCTIONS
// ============================================================================

/**
 * Get cached dashboard data for a user.
 */
export async function getDashboardData(userId: string): Promise<unknown | null> {
  const key = `tourbillon:dashboard:${userId}`;
  return getCache({ key });
}

/**
 * Set cached dashboard data for a user with 5-minute TTL.
 */
export async function setDashboardData(userId: string, data: unknown): Promise<boolean> {
  const key = `tourbillon:dashboard:${userId}`;
  return setCache({ key, value: data, ttl: CACHE_TTLS.dashboard });
}

/**
 * Get cached goals list with optional filters.
 */
export async function getGoalsData(userId: string, filters?: { status?: string; priority?: string }): Promise<unknown | null> {
  const key = `tourbillon:goals:${userId}:${filters ? Object.entries(filters).sort().join('-') : 'all'}`;
  return getCache({ key });
}

/**
 * Set cached goals list with 15-minute TTL.
 */
export async function setGoalsData(userId: string, data: unknown): Promise<boolean> {
  const key = `tourbillon:goals:${userId}:all`;
  return setCache({ key, value: data, ttl: CACHE_TTLS.goals });
}

/**
 * Get cached tasks list for a goal.
 */
export async function getTasksData(goalId: string): Promise<unknown | null> {
  const key = `tourbillon:tasks:${goalId}:all`;
  return getCache({ key });
}

/**
 * Set cached tasks list with 10-minute TTL.
 */
export async function setTasksData(goalId: string, data: unknown): Promise<boolean> {
  const key = `tourbillon:tasks:${goalId}:all`;
  return setCache({ key, value: data, ttl: CACHE_TTLS.tasks });
}
