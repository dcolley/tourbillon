import { db } from '@tourbillon/db';
import { sql } from 'drizzle-orm';
import { ASSISTANT_MAX_PINS_PER_AGENT, ASSISTANT_THREAD_READ_MESSAGE_KEY } from './sidebar';
import { ASSISTANT_THREAD_MODEL_KEY, type ThreadModelChoice } from './thread-model';

/**
 * UI-2: single-statement writes for assistant threads.
 *
 * Every write is one SQL statement whose WHERE clause carries the same scope the API checks
 * (thread id + company free-chat resource + owning agent), so concurrent writes never read,
 * merge and write back a stale copy of the thread:
 * - rename updates only the `title` column of Mastra's thread row;
 * - mark-read sets one metadata key in place (`jsonb_set`);
 * - CHAT-5 model choice sets or removes one metadata key in place (`jsonb_set` / `-`);
 * - pins are rows in `assistant_thread_pins` (insert / delete), not thread metadata;
 * - ASYNC-0 (Slice B) the active thread is one row per (company, agent) in `assistant_active_threads`.
 *
 * Mastra's Postgres store keeps threads in `mastra_threads` (default schema) in the same
 * database as `@tourbillon/db`.
 */
export const MASTRA_THREADS_TABLE = 'mastra_threads';
/** Defined in ./sidebar (pure) so the sidebar client can show the cap without importing the db. */
export { ASSISTANT_MAX_PINS_PER_AGENT };

export interface ThreadScope {
  threadId: string;
  resourceId: string;
  agentId: string;
}

export interface PinScope {
  userKey: string;
  companyId: string;
  agentId: string;
}

const threads = sql.raw(`"${MASTRA_THREADS_TABLE}"`);
const scoped = (s: ThreadScope) =>
  sql`id = ${s.threadId} AND "resourceId" = ${s.resourceId} AND metadata->>'agentId' = ${s.agentId}`;

/** Rename in place. Returns false when no thread matched the scope. */
export async function renameAssistantThreadRow(scope: ThreadScope, title: string): Promise<boolean> {
  const rows = await db.execute(
    sql`UPDATE ${threads} SET title = ${title}, "updatedAt" = (now() AT TIME ZONE 'UTC'), "updatedAtZ" = now() WHERE ${scoped(scope)} RETURNING id`,
  );
  return rows.length > 0;
}

/** Record the last message the user has seen. Returns false when no thread matched the scope. */
export async function markAssistantThreadReadRow(scope: ThreadScope, messageId: string): Promise<boolean> {
  const path = `{${ASSISTANT_THREAD_READ_MESSAGE_KEY}}`;
  const rows = await db.execute(
    sql`UPDATE ${threads} SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${path}::text[], to_jsonb(${messageId}::text), true) WHERE ${scoped(scope)} RETURNING id`,
  );
  return rows.length > 0;
}

/**
 * CHAT-5: set (or, with null, clear) the thread's model choice. Returns false when no thread
 * matched the scope.
 */
export async function setAssistantThreadModelRow(scope: ThreadScope, choice: ThreadModelChoice | null): Promise<boolean> {
  const path = `{${ASSISTANT_THREAD_MODEL_KEY}}`;
  const rows = choice
    ? await db.execute(
        sql`UPDATE ${threads} SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${path}::text[], ${JSON.stringify(choice)}::jsonb, true) WHERE ${scoped(scope)} RETURNING id`,
      )
    : await db.execute(
        sql`UPDATE ${threads} SET metadata = COALESCE(metadata, '{}'::jsonb) - ${ASSISTANT_THREAD_MODEL_KEY}::text WHERE ${scoped(scope)} RETURNING id`,
      );
  return rows.length > 0;
}

/**
 * Pin for one user. Idempotent. Returns false when the user already has the maximum number of
 * pins for this agent (and this thread is not one of them).
 */
export async function pinAssistantThread(scope: PinScope, threadId: string): Promise<boolean> {
  const rows = await db.execute(
    sql`INSERT INTO assistant_thread_pins (user_key, company_id, agent_id, thread_id)
      SELECT ${scope.userKey}, ${scope.companyId}, ${scope.agentId}, ${threadId}
      WHERE (SELECT count(*) FROM assistant_thread_pins
             WHERE user_key = ${scope.userKey} AND company_id = ${scope.companyId} AND agent_id = ${scope.agentId}
               AND thread_id <> ${threadId}) < ${ASSISTANT_MAX_PINS_PER_AGENT}
      ON CONFLICT (user_key, thread_id) DO UPDATE SET company_id = EXCLUDED.company_id, agent_id = EXCLUDED.agent_id
      RETURNING thread_id`,
  );
  return rows.length > 0;
}

/** Unpin for one user. Idempotent. */
export async function unpinAssistantThread(scope: PinScope, threadId: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM assistant_thread_pins WHERE user_key = ${scope.userKey} AND company_id = ${scope.companyId} AND agent_id = ${scope.agentId} AND thread_id = ${threadId}`,
  );
}

/** Thread ids this user pinned for the agent, newest pin first. */
export async function listPinnedAssistantThreadIds(scope: PinScope): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT thread_id FROM assistant_thread_pins WHERE user_key = ${scope.userKey} AND company_id = ${scope.companyId} AND agent_id = ${scope.agentId} ORDER BY created_at DESC LIMIT ${ASSISTANT_MAX_PINS_PER_AGENT}`,
  );
  return (rows as unknown as Array<{ thread_id: string }>).map((r) => r.thread_id);
}

/**
 * ASYNC-0 (Slice B): the agent's active Assistant thread, one row per (company, agent) in
 * `assistant_active_threads`. Every call is one statement.
 */
export interface ActiveThreadScope {
  companyId: string;
  agentId: string;
}

/** The pinned active thread id, or null when the agent has none yet. */
export async function getActiveAssistantThreadId(scope: ActiveThreadScope): Promise<string | null> {
  const rows = await db.execute(
    sql`SELECT thread_id FROM assistant_active_threads WHERE company_id = ${scope.companyId} AND agent_id = ${scope.agentId}`,
  );
  const row = (rows as unknown as Array<{ thread_id?: unknown }>)[0];
  return typeof row?.thread_id === 'string' && row.thread_id ? row.thread_id : null;
}

/** Make `threadId` the active thread (Clear chat / first thread). Last write wins. */
export async function setActiveAssistantThread(scope: ActiveThreadScope, threadId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO assistant_active_threads (company_id, agent_id, thread_id, updated_at)
      VALUES (${scope.companyId}, ${scope.agentId}, ${threadId}, now())
      ON CONFLICT (company_id, agent_id) DO UPDATE SET thread_id = EXCLUDED.thread_id, updated_at = now()`,
  );
}

/**
 * Backfill: pin `threadId` only when the agent has no active thread (`replacing` null) or when it is
 * still `replacing` (a pinned thread that no longer exists). A concurrent Clear always wins.
 * Returns true when `threadId` is now the active thread.
 */
export async function claimActiveAssistantThread(
  scope: ActiveThreadScope,
  threadId: string,
  replacing: string | null,
): Promise<boolean> {
  const rows = await db.execute(
    replacing === null
      ? sql`INSERT INTO assistant_active_threads (company_id, agent_id, thread_id, updated_at)
          VALUES (${scope.companyId}, ${scope.agentId}, ${threadId}, now())
          ON CONFLICT (company_id, agent_id) DO NOTHING
          RETURNING thread_id`
      : sql`UPDATE assistant_active_threads SET thread_id = ${threadId}, updated_at = now()
          WHERE company_id = ${scope.companyId} AND agent_id = ${scope.agentId} AND thread_id = ${replacing}
          RETURNING thread_id`,
  );
  return (rows as unknown as unknown[]).length > 0;
}
