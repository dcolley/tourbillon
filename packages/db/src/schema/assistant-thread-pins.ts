import { pgTable, text, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';

/**
 * UI-2: per-user pins for assistant threads.
 * `threadId` is a Mastra memory thread id (that table is owned by Mastra, so no foreign key).
 * `userKey` identifies the board user who pinned the thread; one row per (user, thread).
 */
export const assistantThreadPins = pgTable(
  'assistant_thread_pins',
  {
    userKey: text('user_key').notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userKey, table.threadId] }),
    index('assistant_thread_pins_user_agent_idx').on(table.userKey, table.companyId, table.agentId),
  ]
);

export type AssistantThreadPin = typeof assistantThreadPins.$inferSelect;
