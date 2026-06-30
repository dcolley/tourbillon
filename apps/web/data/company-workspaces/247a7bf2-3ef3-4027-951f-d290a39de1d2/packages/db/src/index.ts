/**
 * @tourbillon/db — Database package for Tourbillon application
 * 
 * Exports Drizzle ORM tables, DB client, and helper functions.
 */

// Re-export all schema definitions
export {
  subscriptionPlans,
  subscriptions,
  invoices,
  webhookEvents,
} from './schema';

// Export DB client (will be configured when DATABASE_URL is available)
import * as drizzleMod from './drizzle';
export const db = drizzleMod.db;

// Re-export Drizzle ORM utilities for convenience
export { eq, and, or, sql } from 'drizzle-orm';
