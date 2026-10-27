import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

/**
 * TASK-1: the Assistant's private, per-agent chat task list (one list per company + agent).
 *
 * Not company issues: no assignees, no board visibility, no control plane. It lives behind
 * the dashboard-chat AgentController only (chat-task-tools in packages/mastra) and is keyed by
 * (company_id, agent_id) — the same scope as `assistant_active_threads` — so Clear chat
 * (which pins a new Mastra thread) never drops the open tasks. `source_thread_id` is audit
 * only: the Mastra thread the item was created in (no FK — Mastra owns that table).
 */
export const CHAT_TASK_STATUSES = ['pending', 'in_progress', 'waiting_on_user', 'done', 'cancelled'] as const;

export type ChatTaskStatus = (typeof CHAT_TASK_STATUSES)[number];

/** Open = neither done nor cancelled. This is what `listMyTasks` returns by default. */
export const CHAT_TASK_OPEN_STATUSES = ['pending', 'in_progress', 'waiting_on_user'] as const;

export const chatTasks = pgTable(
  'chat_tasks',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status').$type<ChatTaskStatus>().notNull().default('pending'),
    /** Manual ordering within one agent's list (lower = earlier). */
    position: integer('position').notNull().default(0),
    /**
     * The board (human) user who asked for this in chat, best-effort (Derek, 26 Oct): stamped
     * from the chat request's session user when one is resolvable, overridable via updateMyTask.
     * No FK — identity resolution is interim until real login (#107); may name a non-user (e.g.
     * "Bob") once the human says "that one's Bob's". Interested parties live in `notes`, not here.
     */
    requestedByUserId: text('requested_by_user_id'),
    requestedByDisplayName: text('requested_by_display_name'),
    /** The Mastra thread the item was created in (audit only, may point at a retired thread). */
    sourceThreadId: text('source_thread_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('chat_tasks_company_agent_status_idx').on(table.companyId, table.agentId, table.status),
    check(
      'chat_tasks_status_check',
      sql`${table.status} in ('pending', 'in_progress', 'waiting_on_user', 'done', 'cancelled')`,
    ),
  ],
);

export type ChatTask = typeof chatTasks.$inferSelect;
export type NewChatTask = typeof chatTasks.$inferInsert;
