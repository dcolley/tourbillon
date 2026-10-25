import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { agents } from './agents';

/**
 * ASYNC-0 (Slice B): the agent's one active Assistant conversation.
 * One row per (company, agent): `threadId` is the Mastra memory thread the Assistant chat (and its
 * AgentController session + Observational Memory) is on. Clear chat replaces it with a fresh thread,
 * so earlier threads can never come back as "latest by activity".
 * `threadId` is a Mastra memory thread id (that table is owned by Mastra, so no foreign key).
 */
export const assistantActiveThreads = pgTable(
  'assistant_active_threads',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.agentId] })]
);

export type AssistantActiveThread = typeof assistantActiveThreads.$inferSelect;
