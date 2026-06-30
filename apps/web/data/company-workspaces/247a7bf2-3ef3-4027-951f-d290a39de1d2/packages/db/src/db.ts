// Tourbillon Database Client - PostgreSQL with Connection Pooling
import { drizzle } from 'drizzle-orm/neon-serverless';
import * as schema from './schema';
import { eq } from 'drizzle-orm';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create connection pool (handles concurrent requests efficiently)
export const db = drizzle(process.env.DATABASE_URL, {
  schema,
  logger: process.env.NODE_ENV === 'development',
});

export { eq } from 'drizzle-orm';

// Type-safe query helpers for common operations
export async function findUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, email.toLowerCase())
  });
}

export async function createUser(data: {
  email: string;
  passwordHash?: string;
  name?: string;
  provider?: string;
}) {
  return db.insert(schema.users).values({
    ...data,
    email: data.email.toLowerCase()
  }).returning();
}

export async function findUserById(id: string) {
  return db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, id)
  });
}

// Session management helpers
export async function createSession(userId: string, token: string, expiresAt: Date) {
  return db.insert(schema.sessions).values({ userId, token, expiresAt }).returning();
}

export async function findActiveSession(token: string) {
  const session = await db.query.sessions.findFirst({
    where: (sessions, { eq }) => eq(sessions.token, token),
    with: { user: true }
  });
  
  if (!session || new Date(session.expiresAt) < new Date()) {
    return null; // Invalid or expired session
  }
  
  return session;
}

export async function invalidateSession(token: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
}

// Demo request helpers (Phase 2 persistence)
export interface CreateDemoRequestInput {
  name?: string;
  email?: string;
  company?: string;
  message?: string;
  userId?: string | null;
}

export async function createDemoRequest(data: CreateDemoRequestInput) {
  // For now, store in a separate table — will be created via migration
  return { success: true };
}

// Auth-specific helpers for login/signup
export async function findUserByEmailCaseInsensitive(email: string) {
  const result = await db.query.users.findFirst({
    where: (users, { ilike }) => ilike(users.email, email.toLowerCase())
  });
  return result;
}
