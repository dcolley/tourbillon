/**
 * TASK-1: test seam for tools that hit Postgres directly (chat-task-tools, tool-discovery).
 *
 * Production always gets the app's `db` pool. Tests may inject an in-memory PGlite
 * database (`drizzle(pglite, { schema })`) so tool behaviour — scope isolation, caps,
 * friendly errors — is testable without a live database.
 */
import { db as defaultDb, type ChatTaskDb } from '@tourbillon/db';

export type ToolDb = ChatTaskDb;

let injected: ToolDb | null = null;

/** The database a tool call should use: the injected test database, or the app pool. */
export function toolDb(): ToolDb {
  return injected ?? defaultDb;
}

/** Test-only: point tool DB reads at another database (null restores the app pool). */
export function setToolDbForTests(database: ToolDb | null): void {
  injected = database;
}
