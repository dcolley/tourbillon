import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { createId } from '../utils';

// Company skill library — installed skills available for assignment to agents
export const companySkills = pgTable('company_skills', {
  id: text('id').primaryKey().$defaultFn(createId),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),  // e.g. 'control-plane', 'plan-to-tasks'
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),  // Full SKILL.md markdown content
  source: text('source'),  // 'bundled' | 'github:...' | 'custom'
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type CompanySkill = typeof companySkills.$inferSelect;
export type NewCompanySkill = typeof companySkills.$inferInsert;
