/**
 * TASK-LIST-WID: pure helpers behind the task list card (task-list-card.tsx), mirroring
 * chat-card-drafts.ts: what the card holds while pending (one task id for `picker`, a list for
 * `multiSelect`), how it turns that into an answer, and how an answered card replays the stored
 * answer. The checks here only drive the UI; `checkTaskListAnswer` (task-list-specs.ts) is the
 * authority on both client and server.
 */
import { TASK_LIST_STATUSES, type TaskListAnswer, type TaskListProps, type TaskListStatus } from './task-list-specs';

export type TaskListDraft = string | string[] | undefined;

/** What the card holds when it opens: nothing ticked (multiSelect starts empty, picker has no default). */
export function initialTaskListDraft(props: TaskListProps): TaskListDraft {
  return props.mode === 'multiSelect' ? [] : undefined;
}

/** The task ids a draft holds, as a list (picker: zero or one id). */
export function draftTaskIds(selected: TaskListDraft): string[] {
  return Array.isArray(selected) ? selected : selected === undefined ? [] : [selected];
}

/** Bounds a multiSelect card enforces in its UI (same defaults as `checkTaskListAnswer`). */
export function taskListBounds(props: TaskListProps): { min: number; max: number } {
  return { min: props.minSelected ?? 1, max: props.maxSelected ?? props.tasks.length };
}

/**
 * Builds `{ taskId }` (picker) or `{ taskIds }` (multiSelect) from the card's selection.
 * Display cards take no answer from the UI (close = dismiss), so there is nothing to build.
 * Multi-select also checks bounds, de-duplication and membership, so the UI refuses what the
 * server would refuse.
 */
export function taskListDraft(props: TaskListProps, selected: TaskListDraft): DraftResult<TaskListAnswer> {
  const ids = props.tasks.map((t) => t.id);
  if (props.mode === 'multiSelect') {
    const chosen = Array.isArray(selected) ? Array.from(new Set(selected)) : selected === undefined ? [] : [selected];
    const { min, max } = taskListBounds(props);
    if (chosen.length < min) return { ok: false, errors: { taskIds: `Choose at least ${min} task${min === 1 ? '' : 's'}.` } };
    if (chosen.length > max) return { ok: false, errors: { taskIds: `Choose at most ${max} tasks.` } };
    if (chosen.some((id) => !ids.includes(id))) return { ok: false, errors: { taskIds: 'Pick tasks from the list.' } };
    return { ok: true, answer: { taskIds: chosen } };
  }
  if (props.mode === 'picker') {
    const single = Array.isArray(selected) ? selected[0] : selected;
    if (single === undefined || !ids.includes(single)) return { ok: false, errors: { taskId: 'Pick one task.' } };
    return { ok: true, answer: { taskId: single } };
  }
  return { ok: false, errors: {} };
}

/**
 * The task ids the card shows ticked/selected. An answered card replays the stored answer
 * (`{ taskId }` or `{ taskIds }`), so history replay ticks what was actually chosen; only a
 * pending card shows the draft.
 */
export function checkedTaskIds(status: string, answer: TaskListAnswer | undefined, selected: TaskListDraft): string[] {
  if (status === 'answered') {
    if (answer === undefined) return [];
    if ('taskIds' in answer) return [...answer.taskIds];
    if ('taskId' in answer) return [answer.taskId];
    return [];
  }
  return draftTaskIds(selected);
}

/** Title of a task by id (answered card), or undefined. */
export function taskLabel(props: TaskListProps, id: string | undefined): string | undefined {
  return props.tasks.find((t) => t.id === id)?.title;
}

/** Titles of the chosen tasks (answered card); ids stand in for unknown ones. */
export function taskLabels(props: TaskListProps, ids: string[] | undefined): string {
  return (ids ?? []).map((id) => props.tasks.find((t) => t.id === id)?.title ?? id).join(', ');
}

const STATUS_TEXT: Record<TaskListStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  waiting_on_user: 'waiting on you',
  done: 'done',
  cancelled: 'cancelled',
};

/** Chip text for a status (unknown statuses pass through). */
export function taskStatusText(status: TaskListStatus): string {
  return STATUS_TEXT[status] ?? status;
}

export type DraftResult<A> = { ok: true; answer: A } | { ok: false; errors: Record<string, string> };

export { TASK_LIST_STATUSES };
