import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { createId } from '../utils';

// Forward declare for self-reference
const agentMailTable = pgTable('agent_mail', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  body: text('body').notNull(),
  inReplyTo: text('in_reply_to'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agentMail = agentMailTable;

// Apply foreign key constraints after table declaration
// This is handled by migration SQL

export const agentMailRelations = relations(agentMail, ({ one }) => ({
  company: one(companies, { fields: [agentMail.companyId], references: [companies.id] }),
  parentMail: one(agentMail, { fields: [agentMail.inReplyTo], references: [agentMail.id], relationName: 'reply_thread' }),
}));

export type AgentMail = typeof agentMail.$inferSelect;
export type NewAgentMail = typeof agentMail.$inferInsert;
