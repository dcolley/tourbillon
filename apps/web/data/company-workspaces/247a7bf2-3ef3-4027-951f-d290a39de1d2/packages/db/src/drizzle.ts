import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.warn('[DB] DATABASE_URL not set. Using in-memory fallback for development.');
}

export const db = drizzle(DATABASE_URL, { schema });
