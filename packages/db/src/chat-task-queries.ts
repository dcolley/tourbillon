/**
 * TASK-1: the Assistant's private chat task list — query layer.
 *
 * One private, todo-style list per (company, agent): what the agent said it would do in chat,
 * is doing, or is waiting on the human for. Deliberately NOT company issues — no assignees, no
 * board visibility, nothing goes through the control plane. Every function takes the
 * `{ companyId, agentId }` scope and filters by it, so one agent can never read or write
 * another agent's rows, and neither can another company.
 *
 * The list is keyed by the same scope as `assistant_active_threads`, so it survives Clear chat
 * (a Clear pins a fresh Mastra thread; the rows stay). `sourceThreadId` records the thread the
 * item was created in, for audit only. `requestedBy*` records who asked for it (the board user
 * on the chat request, best-effort — Derek, 26 Oct); `notes` may carry the interested-parties
 * list ("Notify: …" lines) — there is no notify transport in this story.
 *
 * Same shape as company-llm-provider-queries: `database` is injectable (the app pool by default,
 * an in-memory PGlite database in tests).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { db } from './client';
import type * as schema from './schema/index';
import { CHAT_TASK_OPEN_STATUSES, chatTasks, type ChatTask, type ChatTaskStatus } from './schema/chat-tasks';

/** Any Drizzle Postgres database over this schema (the app pool, or an in-memory one in tests). */
export type ChatTaskDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defaultDb = db as unknown as ChatTaskDb;

/** The (company, agent) scope one chat task list belongs to. */
export interface ChatTaskScope {
  companyId: string;
  agentId: string;
}

/** Who asked for a task, best-effort (may name a non-user until real login, #107). */
export interface ChatTaskRequester {
  userId?: string | null;
  displayName?: string | null;
}

export interface ListChatTasksOptions {
  /** Include `done` + `cancelled` (default: open items only). */
  includeClosed?: boolean;
}

export interface AddChatTaskInput {
  title: string;
  notes?: string | null;
  status?: ChatTaskStatus;
  /** Omitted = after the current tail (max position + 1). */
  position?: number;
  sourceThreadId?: string | null;
  /** Stamped by the tool layer from the chat request context, never supplied by the model. */
  requestedBy?: ChatTaskRequester | null;
}

export interface UpdateChatTaskInput {
  id: string;
  title?: string;
  notes?: string | null;
  status?: ChatTaskStatus;
  position?: number;
  /** Overridable (Derek, 26 Oct): e.g. the human says "that one's Bob's". */
  requestedBy?: ChatTaskRequester | null;
}

const scopeWhere = (scope: ChatTaskScope) => [
  eq(chatTasks.companyId, scope.companyId),
  eq(chatTasks.agentId, scope.agentId),
];

const OPEN_STATUSES = [...CHAT_TASK_OPEN_STATUSES];

/** Open = not done and not cancelled. */
export function isOpenChatTaskStatus(status: ChatTaskStatus): boolean {
  return (CHAT_TASK_OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * The agent's task list. Open items by default (`includeClosed` also returns done/cancelled),
 * ordered by `position` then creation time.
 */
export async function listChatTasks(
  scope: ChatTaskScope,
  options: ListChatTasksOptions = {},
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask[]> {
  const where = options.includeClosed
    ? and(...scopeWhere(scope))
    : and(...scopeWhere(scope), inArray(chatTasks.status, OPEN_STATUSES));
  return database
    .select()
    .from(chatTasks)
    .where(where)
    .orderBy(asc(chatTasks.position), asc(chatTasks.createdAt));
}

/** Number of open (not done/cancelled) items in the agent's list — used to cap the list size. */
export async function countOpenChatTasks(
  scope: ChatTaskScope,
  database: ChatTaskDb = defaultDb,
): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(chatTasks)
    .where(and(...scopeWhere(scope), inArray(chatTasks.status, OPEN_STATUSES)));
  return Number(row?.n ?? 0);
}

/**
 * Add one item to the agent's list. Position defaults to the tail; `done` gets `completedAt`
 * set immediately (an item added as already-done is a bookkeeping entry, still legal).
 */
export async function addChatTask(
  scope: ChatTaskScope,
  input: AddChatTaskInput,
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask> {
  const status: ChatTaskStatus = input.status ?? 'pending';
  let position = input.position;
  if (position === undefined) {
    const [tail] = await database
      .select({ max: sql<number>`coalesce(max(${chatTasks.position}), -1)::int` })
      .from(chatTasks)
      .where(and(...scopeWhere(scope)));
    position = Number(tail?.max ?? -1) + 1;
  }
  const now = new Date();
  const [row] = await database
    .insert(chatTasks)
    .values({
      companyId: scope.companyId,
      agentId: scope.agentId,
      title: input.title.trim(),
      notes: input.notes?.trim() || null,
      status,
      position,
      requestedByUserId: input.requestedBy?.userId?.trim() || null,
      requestedByDisplayName: input.requestedBy?.displayName?.trim() || null,
      sourceThreadId: input.sourceThreadId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'done' ? now : null,
    })
    .returning();
  return row!;
}

/** Update title/notes/status/position/requestedBy of one item. Null = the id is not in this agent's list. */
export async function updateChatTask(
  scope: ChatTaskScope,
  input: UpdateChatTaskInput,
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.position !== undefined) updates.position = input.position;
  if (input.requestedBy !== undefined) {
    updates.requestedByUserId = input.requestedBy?.userId?.trim() || null;
    updates.requestedByDisplayName = input.requestedBy?.displayName?.trim() || null;
  }
  if (input.status !== undefined) {
    updates.status = input.status;
    updates.completedAt = input.status === 'done' ? new Date() : null;
  }
  const [row] = await database
    .update(chatTasks)
    .set(updates)
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .returning();
  return row ?? null;
}

/** Move one item to another status; an optional note is appended to `notes`. */
export async function setChatTaskStatus(
  scope: ChatTaskScope,
  input: { id: string; status: ChatTaskStatus; note?: string | null },
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const [existing] = await database
    .select()
    .from(chatTasks)
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .limit(1);
  if (!existing) return null;
  const note = input.note?.trim();
  const notes = note ? [existing.notes, note].filter(Boolean).join('\n') : existing.notes;
  const now = new Date();
  const [row] = await database
    .update(chatTasks)
    .set({
      status: input.status,
      notes,
      updatedAt: now,
      completedAt: input.status === 'done' ? now : null,
    })
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .returning();
  return row ?? null;
}
