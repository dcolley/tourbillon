/**
 * Tourbillon Cache Keys — TOUR-145
 * 
 * Centralized cache key management with consistent naming patterns.
 * All cache keys follow: tourbillon:{entity}:{identifier}[:variant]
 */

export interface CacheKeyParts {
  entity: string;      // e.g., 'dashboard', 'goals', 'tasks', 'settings'
  identifier?: string; // user ID, goal ID, etc.
  variant?: string;    // additional qualifier (e.g., 'weekly', 'priority')
}

/**
 * Generate a cache key from parts.
 */
export function createCacheKey(parts: CacheKeyParts): string {
  const base = `tourbillon:${parts.entity}`;
  if (parts.identifier) {
    return `${base}:${parts.identifier}`;
  }
  return base;
}

/**
 * Generate a cache key for user dashboard data.
 */
export function getDashboardKey(userId: string): string {
  return `tourbillon:dashboard:${userId}`;
}

/**
 * Generate a cache key for goals list with optional filters.
 */
export function getGoalsKey(userId: string, filters?: { status?: string; priority?: string }): string {
  const base = `tourbillon:goals:${userId}`;
  if (!filters) return `${base}:all`;
  
  const parts = [filters.status || 'any', filters.priority || 'any'];
  return `${base}:${parts.join('-')}`;
}

/**
 * Generate a cache key for tasks list with optional goal filter.
 */
export function getTasksKey(goalId: string, status?: string): string {
  const base = `tourbillon:tasks:${goalId}`;
  if (!status) return `${base}:all`;
  return `${base}:${status}`;
}

/**
 * Generate a cache key for user settings.
 */
export function getSettingsKey(userId: string): string {
  return `tourbillon:settings:${userId}`;
}

/**
 * Generate a cache key for project data.
 */
export function getProjectKey(projectId: string): string {
  return `tourbillon:project:${projectId}`;
}

/**
 * Invalidate all cache keys matching an entity pattern (wildcard-like).
 * Since Redis doesn't support true wildcards in delete, we store a list of keys.
 */
export function getInvalidatePattern(entity: string): string {
  return `tourbillon:${entity}:*`;
}

/**
 * Get common TTL values for different entity types (in seconds).
 */
export const CACHE_TTLS = {
  dashboard: 300,      // 5 minutes — frequently updated
  goals: 900,          // 15 minutes — less volatile
  tasks: 600,          // 10 minutes — moderate change frequency
  settings: 1800,      // 30 minutes — rarely changes
  project: 900,        // 15 minutes
} as const;

export type CacheTTLKey = keyof typeof CACHE_TTLS;

/**
 * Get TTL for a specific entity type. Falls back to default if not found.
 */
export function getCacheTTL(entityType: string): number {
  return (CACHE_TTLS[entityType as CacheTTLKey] ?? 600); // Default 10 minutes
}
