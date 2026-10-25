import { db } from '@tourbillon/db';
import { sql } from 'drizzle-orm';
import { MASTRA_THREADS_TABLE, type ThreadScope } from './thread-store';
import { ASSISTANT_FEEDBACK_METADATA_KEY, type MessageFeedback } from './feedback';

/**
 * OBS-2: one SQL statement per reaction, scoped like the other assistant thread writes
 * (thread id + company free-chat resource + owning agent; see thread-store.ts). The entry replaces
 * the user's previous reaction for that message in `metadata.assistantFeedback[messageId][userKey]`,
 * leaving other messages, other users and the rest of the metadata untouched.
 * Returns false when no thread matched the scope.
 */
export async function saveAssistantMessageFeedbackRow(
  scope: ThreadScope,
  messageId: string,
  userKey: string,
  entry: MessageFeedback,
): Promise<boolean> {
  const threads = sql.raw(`"${MASTRA_THREADS_TABLE}"`);
  const key = ASSISTANT_FEEDBACK_METADATA_KEY;
  const path = `{${key}}`;
  const all = sql`CASE WHEN jsonb_typeof(metadata->${key}::text) = 'object' THEN metadata->${key}::text ELSE '{}'::jsonb END`;
  const forMessage = sql`CASE WHEN jsonb_typeof(metadata->${key}::text->${messageId}::text) = 'object' THEN metadata->${key}::text->${messageId}::text ELSE '{}'::jsonb END`;
  const value = JSON.stringify(entry);
  const rows = await db.execute(
    sql`UPDATE ${threads} SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${path}::text[], ${all} || jsonb_build_object(${messageId}::text, ${forMessage} || jsonb_build_object(${userKey}::text, ${value}::jsonb)), true) WHERE id = ${scope.threadId} AND "resourceId" = ${scope.resourceId} AND metadata->>'agentId' = ${scope.agentId} RETURNING id`,
  );
  return rows.length > 0;
}
