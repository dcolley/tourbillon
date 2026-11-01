import { check, index, pgTable, text, timestamp, integer, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

/**
 * Company Computer (Slice 1) — one KasmVNC seat per agent, registry rows only.
 *
 * The host layout is a PM+Ops lock: /opt/tourbillon-company-{companyId}/data (shared,
 * mounted at /data) and /opt/tourbillon-company-{companyId}/home/{agentUrlKey}
 * (per-agent, mounted at /home/kasm-user). See docs/spikes/company-computer.md and
 * packages/company-computer/src/constants.ts — never reintroduce the discarded
 * /home/derek/company-computers shared-overlay draft.
 */
export const companyComputerSessions = pgTable(
  'company_computer_sessions',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    agentUrlKey: text('agent_url_key').notNull(),
    // e.g. cc-<companySlug-or-id>-<agentUrlKey>
    containerName: text('container_name').notNull(),
    // Pinned image the seat was created with (e.g. kasmweb/desktop:1.19.0).
    image: text('image').notNull(),
    // Host port bound to the container's KasmVNC 6901 (PORT_BASE 6901 upward).
    vncPort: integer('vnc_port').notNull(),
    status: text('status', { enum: ['starting', 'running', 'stopped', 'destroyed'] })
      .notNull()
      .default('starting'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    // Takeover fields are optional (watch/takeover protocol is Slice 2+).
    takeoverStatus: text('takeover_status', { enum: ['watching', 'taken_over'] }),
    takeoverUserId: text('takeover_user_id'),
    takeoverAt: timestamp('takeover_at', { withTimezone: true }),
    // Forward-compat hook for Slice 2+ seat metadata (container id, resource usage).
    meta: jsonb('meta').notNull().default({}),
  },
  (table) => [
    index('company_computer_sessions_company_agent_status_idx').on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    check(
      'company_computer_sessions_status_check',
      sql`${table.status} in ('starting', 'running', 'stopped', 'destroyed')`,
    ),
    check(
      'company_computer_sessions_takeover_status_check',
      sql`${table.takeoverStatus} in ('watching', 'taken_over')`,
    ),
  ],
);

export const companyComputerSessionsRelations = relations(companyComputerSessions, ({ one }) => ({
  company: one(companies, { fields: [companyComputerSessions.companyId], references: [companies.id] }),
  agent: one(agents, { fields: [companyComputerSessions.agentId], references: [agents.id] }),
}));

export type CompanyComputerSession = typeof companyComputerSessions.$inferSelect;
export type NewCompanyComputerSession = typeof companyComputerSessions.$inferInsert;
