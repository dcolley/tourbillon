/**
 * TASK-1: the Assistant's private chat task list — the five AgentController tools.
 *
 * One private, todo-style list per (company, agent), stored in `chat_tasks` (Tourbillon-owned,
 * not company issues). The agent uses these to track what it said it would do in chat; when the
 * human asks "what's left / status / what are you working on?" it answers from `listMyTasks`.
 * `getInbox` stays for assigned company ISSUES only — that is the source of the old confusion
 * this closes.
 *
 * Scope comes ONLY from the chat request context (`agentId` + `companyId` via
 * `extractToolRuntimeContext`); there is no model-supplied agent/company parameter, and a call
 * without a context returns an error and writes nothing. Registered for dashboard chat only —
 * never in CONTROL_PLANE_TOOLS / ROLE_TOOLS / heartbeats / DurableAgent.
 *
 * Transport: direct Postgres (`toolDb()` → the app pool, injectable in tests) through the
 * @tourbillon/db chat-task query layer. `source_thread_id` is stamped from the runtime context's
 * threadId (or the heartbeat AsyncLocalStorage context) for audit; `requestedBy` is stamped from
 * the chat request's session user when one is resolvable (see apps/web request-user plumbing).
 */
import { createTool } from '@mastra/core/tools';
import {
  addChatTask,
  countOpenChatTasks,
  listChatTasks,
  setChatTaskStatus,
  updateChatTask,
  CHAT_TASK_STATUSES,
  isOpenChatTaskStatus,
  type ChatTask,
  type ChatTaskScope,
} from '@tourbillon/db';
import { z } from 'zod';
import { extractToolRuntimeContext } from './api-client';
import { getCurrentHeartbeatContext } from '../heartbeat-context';
import { toolDb } from './tool-db';

/** Ids of the five chat-task tools — used to keep them out of heartbeat/issue tool sets. */
export const CHAT_TASK_TOOL_IDS = [
  'listMyTasks',
  'addMyTask',
  'updateMyTask',
  'completeMyTask',
  'cancelMyTask',
] as const;

/** Hard cap so the list stays a memory aid, not a backlog. */
export const CHAT_TASK_LIST_CAP = 50;

const CHAT_TASK_TITLE_MAX = 200;

function missingScope(): { error: string; message: string } {
  return {
    error: 'missing_scope',
    message:
      'Chat-task tools need the chat request context (agentId + companyId). Nothing was read or written.',
  };
}

/** Scope + audit info from the request context only — never from model-supplied ids. */
function chatTaskScope(requestContext: unknown): (ChatTaskScope & { threadId?: string }) | null {
  const ctx = extractToolRuntimeContext(requestContext);
  if (!ctx.agentId || !ctx.companyId) return null;
  // /api/agui wraps chat runs in runWithHeartbeatContext too, so fall back to the ALS context.
  const threadId = ctx.threadId ?? getCurrentHeartbeatContext()?.threadId;
  return { companyId: ctx.companyId, agentId: ctx.agentId, threadId };
}

function requestingUser(requestContext: unknown): { userId?: string; displayName?: string } | null {
  const ctx = extractToolRuntimeContext(requestContext);
  if (!ctx.requestingUserId && !ctx.requestingUserDisplayName) return null;
  return { userId: ctx.requestingUserId, displayName: ctx.requestingUserDisplayName };
}

const statusSchema = z.enum(CHAT_TASK_STATUSES);

function statusCounts(tasks: ChatTask[]): string {
  const open = tasks.filter((t) => isOpenChatTaskStatus(t.status));
  const by = (s: string) => tasks.filter((t) => t.status === s).length;
  const bits = Object.entries({
    pending: by('pending'),
    in_progress: by('in_progress'),
    waiting_on_user: by('waiting_on_user'),
    done: by('done'),
    cancelled: by('cancelled'),
  })
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return `${open.length} open (${bits.join(', ') || 'none'})`;
}

function row(task: ChatTask) {
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.requestedByDisplayName ? { requestedBy: task.requestedByDisplayName } : {}),
  };
}

const notFound = (id: string) => ({
  error: 'task_not_found',
  message: `No chat task "${id}" in your list. Call listMyTasks to see it.`,
});

export const listMyTasksTool = createTool({
  id: 'listMyTasks',
  description:
    'List YOUR private chat task list — the to-dos you promised in this chat (pending / in_progress / ' +
    'waiting_on_user by default; pass includeClosed for done + cancelled too). ' +
    'This is NOT company issues or assignments — for assigned company ISSUES use getInbox instead. ' +
    'Call this FIRST whenever the human asks what is left, what you are working on, your status, ' +
    'what you promised, or whether something got done — then answer in plain language from the result. ' +
    'Never invent items: if the list is empty, say so.',
  inputSchema: z.object({
    includeClosed: z.boolean().optional().describe('Also return done and cancelled tasks (default false).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const tasks = await listChatTasks(scope, { includeClosed: inputData.includeClosed }, toolDb());
    const open = tasks.filter((t) => isOpenChatTaskStatus(t.status));
    return {
      summary: tasks.length === 0 ? 'No open tasks.' : statusCounts(tasks),
      count: tasks.length,
      open: open.length,
      tasks: tasks.map(row),
    };
  },
});

export const addMyTaskTool = createTool({
  id: 'addMyTask',
  description:
    'Add one or more to-dos to YOUR private chat task list (NOT company issues — do not use ' +
    'createIssue/createSubtask for chat to-dos). Use when you commit to multi-step work in chat, or ' +
    'the human asks you to remember to do something. Optional notes may name interested parties to ' +
    'notify about progress (there is no automatic notifying). Titles are imperative, ≤200 chars.',
  inputSchema: z.object({
    titles: z
      .array(z.string().min(1).max(CHAT_TASK_TITLE_MAX))
      .min(1)
      .max(10)
      .describe('One or more task titles, e.g. ["Draft the runbook", "Check the restore backup"].'),
    notes: z.string().max(2000).optional().describe('Optional context/next step, or a "notify:" list of interested parties.'),
    status: statusSchema.optional().describe('Initial status (default pending).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const database = toolDb();
    const titles = inputData.titles.map((t) => t.trim()).filter(Boolean);
    if (titles.length === 0) {
      return { error: 'empty_titles', message: 'At least one non-empty task title is required.' };
    }
    const open = await countOpenChatTasks(scope, database);
    if (open + titles.length > CHAT_TASK_LIST_CAP) {
      return {
        error: 'task_list_full',
        message: `Your task list is capped at ${CHAT_TASK_LIST_CAP} open tasks (${open} open now). Finish or cancel some first.`,
      };
    }
    const added: ChatTask[] = [];
    for (const title of titles) {
      added.push(
        await addChatTask(
          scope,
          {
            title,
            notes: inputData.notes,
            status: inputData.status,
            sourceThreadId: scope.threadId ?? null,
            requestedBy: requestingUser(requestContext),
          },
          database,
        ),
      );
    }
    return {
      ok: true,
      message: `Added ${added.length} task${added.length === 1 ? '' : 's'}.`,
      tasks: added.map(row),
    };
  },
});

export const updateMyTaskTool = createTool({
  id: 'updateMyTask',
  description:
    'Update one of YOUR chat tasks by id — your private chat task list, NOT company issues: rename it, ' +
    'replace its notes, move its status (pending / in_progress / waiting_on_user / done / cancelled), ' +
    'reorder it, or change who requested it (when the human corrects who a to-do belongs to).',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    title: z.string().min(1).max(CHAT_TASK_TITLE_MAX).optional(),
    notes: z.string().max(2000).optional().describe('Replaces the notes text ("" clears it).'),
    status: statusSchema.optional(),
    position: z.number().int().min(0).optional().describe('Ordering within your list (lower = earlier).'),
    requestedBy: z
      .object({
        userId: z.string().max(64).optional(),
        displayName: z.string().max(120).optional(),
      })
      .optional()
      .describe('Override who asked for this task (use when the human says whose it is).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const updated = await updateChatTask(
      scope,
      {
        id: inputData.id,
        ...(inputData.title !== undefined ? { title: inputData.title } : {}),
        ...(inputData.notes !== undefined ? { notes: inputData.notes } : {}),
        ...(inputData.status !== undefined ? { status: inputData.status } : {}),
        ...(inputData.position !== undefined ? { position: inputData.position } : {}),
        ...(inputData.requestedBy !== undefined ? { requestedBy: inputData.requestedBy } : {}),
      },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    return { ok: true, message: `Task ${updated.id} → ${updated.status}.`, task: row(updated) };
  },
});

export const completeMyTaskTool = createTool({
  id: 'completeMyTask',
  description:
    'Mark one of YOUR chat tasks done by id — private chat list, NOT company issues — with an optional ' +
    'one-line note (what you did / where the result lives). Use it as soon as a promised to-do is actually finished.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    note: z.string().max(2000).optional().describe('Optional note appended to the task notes.'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const updated = await setChatTaskStatus(
      scope,
      { id: inputData.id, status: 'done', note: inputData.note },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    return { ok: true, message: `Task ${updated.id} → done.`, task: row(updated) };
  },
});

export const cancelMyTaskTool = createTool({
  id: 'cancelMyTask',
  description:
    'Drop one of YOUR chat tasks (status → cancelled) — private chat list, NOT company issues — with an ' +
    'optional reason. Use when the human says to drop/forget a to-do, or a promised step is no longer needed. ' +
    'Cancelled items stay in the list and are hidden from the default listMyTasks view.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    reason: z.string().max(2000).optional().describe('Optional reason appended to the task notes.'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const updated = await setChatTaskStatus(
      scope,
      { id: inputData.id, status: 'cancelled', note: inputData.reason },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    return { ok: true, message: `Task ${updated.id} → cancelled.`, task: row(updated) };
  },
});

/** The five chat-task tools as one group (chat AgentController only — see chat-controller.ts). */
export const CHAT_TASK_TOOLS = {
  listMyTasks: listMyTasksTool,
  addMyTask: addMyTaskTool,
  updateMyTask: updateMyTaskTool,
  completeMyTask: completeMyTaskTool,
  cancelMyTask: cancelMyTaskTool,
};

/** True for ids that belong to the private chat list (guards + toolset labelling). */
export function isChatTaskToolId(id: string): boolean {
  return (CHAT_TASK_TOOL_IDS as readonly string[]).includes(id);
}
