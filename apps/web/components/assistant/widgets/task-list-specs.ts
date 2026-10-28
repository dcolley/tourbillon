/**
 * TASK-LIST-WID: the chat task list card (specs, no component).
 *
 * Surfaces the AgentController's private `chat_tasks` list (#189) in the chat as an AG-UI widget:
 * the agent calls `showTaskList` with rows it just read from `listMyTasks` and the run pauses on
 * the card. Three modes, one widget:
 *
 * - `display` — read-only list (the answer to "what are you working on?"); never requires a
 *   selection. The run resumes when the user closes/dismisses the card (an `{ ack: true }` answer
 *   is also accepted, but the UI closes by dismissal, like every card that takes no selection).
 * - `picker` — single-select one task; answers `{ taskId }`.
 * - `multiSelect` — tick any number of tasks (WID-MS pattern); answers `{ taskIds }` within
 *   optional `minSelected` / `maxSelected` bounds (defaults 1 and all tasks).
 *
 * Props carry the task rows (id, title, optional status/notes) because the widget is presentational:
 * task editing stays with `updateMyTask` / `completeMyTask` / `cancelMyTask`. Answers are checked
 * twice with the same code (`checkTaskListAnswer`): in the browser through the client registry and
 * on the server through the AG-UI route, so a client cannot answer outside the offered tasks.
 */
import { z } from 'zod';
import type { WidgetSpec } from '@tourbillon/shared/widgets';

/** Same cap as `CHAT_TASK_LIST_CAP` (packages/mastra chat-task-tools): a memory aid, not a backlog. */
export const TASK_LIST_MAX_TASKS = 50;

/** The chat-task statuses (`chat_tasks` schema / `listMyTasks` rows). */
export const TASK_LIST_STATUSES = ['pending', 'in_progress', 'waiting_on_user', 'done', 'cancelled'] as const;
export type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

/** Chat task ids and the option ids elsewhere (uuid-safe character set). */
const taskListId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const taskListProps = z.strictObject({
  title: text(200).describe('What the card is showing (a heading, e.g. "What I am working on").'),
  detail: optionalText(1000).describe('Optional context shown under the title.'),
  mode: z.enum(['display', 'picker', 'multiSelect']).describe(
    'display: read-only list (close-only, no selection). picker: pick exactly one task. multiSelect: tick any number within the bounds.',
  ),
  tasks: z
    .array(
      z.strictObject({
        id: taskListId.describe('Chat task id, copied from listMyTasks.'),
        title: text(200),
        status: z.enum(TASK_LIST_STATUSES).optional().describe('Shown as a chip on the row.'),
        notes: optionalText(500).describe('Optional short note under the title.'),
      }),
    )
    .min(1)
    .max(TASK_LIST_MAX_TASKS)
    .describe('The tasks to show, in list order (copied verbatim from listMyTasks).'),
  minSelected: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('multiSelect only: fewest tasks the user must tick (default 1).'),
  maxSelected: z
    .number()
    .int()
    .min(1)
    .max(TASK_LIST_MAX_TASKS)
    .optional()
    .describe('multiSelect only: most tasks the user may tick (default: all tasks).'),
}).superRefine((p, ctx) => {
  const ids = p.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'duplicate_id' });
  // S7 (askForm WID-MS pattern): selection bounds are multiSelect props - refuse them on display/picker.
  if (p.mode !== 'multiSelect' && (p.minSelected !== undefined || p.maxSelected !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'multi_select_only' });
  }
  if (p.mode === 'multiSelect') {
    const max = p.maxSelected ?? p.tasks.length;
    const min = p.minSelected ?? 1;
    if (min > max) ctx.addIssue({ code: 'custom', path: ['minSelected'], message: 'min_above_max' });
    if (max > p.tasks.length) ctx.addIssue({ code: 'custom', path: ['maxSelected'], message: 'max_above_tasks' });
  }
});
export type TaskListProps = z.infer<typeof taskListProps>;

/**
 * Answers this card takes: `display` only ever an acknowledgment (it selects nothing), `picker` one
 * offered task, `multiSelect` a list of offered tasks. Mode + bounds are enforced by
 * `checkTaskListAnswer`; a `{ taskIds }` answer in a single-select card is refused (`multi_only`).
 */
export const taskListAnswer = z.union([
  z.strictObject({ ack: z.literal(true) }),
  z.strictObject({ taskId: taskListId }),
  z.strictObject({ taskIds: z.array(taskListId).max(TASK_LIST_MAX_TASKS) }),
]);
export type TaskListAnswer = z.infer<typeof taskListAnswer>;

/**
 * Checks a task-list answer against the props the card was asked with (same rules as the choice
 * card's multi-select, WID-MS). `display` refuses selections (it never requires one); `picker`
 * takes exactly one offered task; `multiSelect` takes a de-duplicated list of offered tasks within
 * `minSelected` / `maxSelected` (defaults 1 and all tasks).
 */
export function checkTaskListAnswer(props: TaskListProps, answer: TaskListAnswer): string[] {
  const ids = props.tasks.map((t) => t.id);
  if (props.mode === 'display') {
    if ('ack' in answer) return [];
    return 'taskId' in answer ? ['taskId: display_mode'] : ['taskIds: display_mode'];
  }
  if (props.mode === 'picker') {
    if ('taskIds' in answer) return ['taskIds: multi_only'];
    if ('ack' in answer) return ['taskId: not_a_task'];
    return ids.includes(answer.taskId) ? [] : ['taskId: not_a_task'];
  }
  if (!('taskIds' in answer)) return ['taskIds: invalid_type'];
  const chosen = answer.taskIds;
  const issues: string[] = [];
  if (new Set(chosen).size !== chosen.length) issues.push('taskIds: duplicate_id');
  if (chosen.some((id) => !ids.includes(id))) issues.push('taskIds: not_a_task');
  const min = props.minSelected ?? 1;
  const max = props.maxSelected ?? props.tasks.length;
  if (chosen.length < min) issues.push('taskIds: too_few');
  if (chosen.length > max) issues.push('taskIds: too_many');
  return issues;
}

export const taskListSpec: WidgetSpec<TaskListProps, TaskListAnswer> = {
  name: 'showTaskList',
  version: 1,
  description:
    'Show your private chat task list in the chat as a card and wait for the answer. Call listMyTasks first, then pass those rows ' +
    'verbatim (id, title, status, notes). The card needs at least one task: if listMyTasks returns no tasks, do not call it - ' +
    'answer in plain text instead. Modes: "display" for a read-only status list (the user closes it; it never asks for a ' +
    'selection); "picker" to have the user pick exactly one task (answer { taskId }); "multiSelect" to pick several (answer ' +
    '{ taskIds }, optional minSelected/maxSelected, minSelected: 0 allows an empty submit). ' +
    'Use it for your chat to-dos (chat_tasks), never for company issues; to change a task use updateMyTask/completeMyTask/cancelMyTask, ' +
    'never edit inside this card.',
  propsSchema: taskListProps,
  answerSchema: taskListAnswer,
  frontendTool: true,
  checkAnswer: checkTaskListAnswer,
};
