'use client';

/**
 * TASK-LIST-WID: the chat task list card. One compiled component for the `showTaskList` spec
 * (task-list-specs.ts): `display` is read-only (Close dismisses the card, no Submit), `picker`
 * selects exactly one task and `multiSelect` ticks any number within the card's bounds — both
 * gated like the WID-MS ChoiceCard (Submit disabled until the selection fits). Status comes from
 * the props, never from anything live; answered and dismissed cards render locked with the outcome.
 * All text from the agent (titles, notes) is rendered as React text, never as markup.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { taskListSpec, type TaskListAnswer, type TaskListProps } from './task-list-specs';
import { CardFrame, FieldError } from './chat-cards';
import { checkedTaskIds, taskLabel, taskLabels, taskListDraft, taskStatusText } from './task-list-drafts';
import type { WidgetComponentProps, WidgetDefinition } from './widget-types';

/** The ticked/selected task ids of a pending card (checkbox state; also replays a stored answer). */
export function TaskListRows({
  props,
  selected,
  selectable,
  locked,
  errorId,
  error,
  onToggle,
}: {
  props: TaskListProps;
  selected: string[];
  selectable: boolean;
  /** Answered, dismissed or no answer handler: inputs still render (replayed selection) but are inert. */
  locked: boolean;
  errorId: string;
  error?: string;
  onToggle: (id: string, on: boolean) => void;
}) {
  const multi = props.mode === 'multiSelect';
  return (
    <fieldset className="space-y-1" disabled={!selectable || locked}>
      <legend className="sr-only">Tasks</legend>
      {props.tasks.map((task) => (
        <label
          key={task.id}
          className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 has-[:checked]:border-primary"
          data-task={task.id}
        >
          {selectable && (
            <input
              type={multi ? 'checkbox' : 'radio'}
              name={`${task.id}-${multi ? 'multi' : 'one'}`}
              value={task.id}
              checked={selected.includes(task.id)}
              onChange={(e) => onToggle(task.id, e.target.checked)}
              className="mt-0.5"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          )}
          <span className="flex flex-col">
            <span>{task.title}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {task.status && (
                <span className="rounded bg-muted px-1.5" data-task-status={task.status}>
                  {taskStatusText(task.status)}
                </span>
              )}
              {task.notes && <span>{task.notes}</span>}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function TaskListCard({ props, status, answer, onAnswer, onDismiss, busy }: WidgetComponentProps<TaskListProps, TaskListAnswer>) {
  const selectable = props.mode === 'picker' || props.mode === 'multiSelect';
  const [selected, setSelected] = React.useState<string[]>(() => {
    const replay = checkedTaskIds(status, answer, undefined);
    return replay;
  });
  const [error, setError] = React.useState<string | undefined>();
  const listId = React.useId();
  const errorId = `${listId}-error`;
  const locked = !onAnswer || status !== 'pending';
  const bounds = props.mode === 'multiSelect' ? { min: props.minSelected ?? 1, max: props.maxSelected ?? props.tasks.length } : undefined;
  const inBounds = props.mode === 'multiSelect' ? selected.length >= (bounds?.min ?? 1) && selected.length <= (bounds?.max ?? props.tasks.length) : selected.length === 1;
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => (props.mode === 'multiSelect' ? (on ? [...current, id] : current.filter((x) => x !== id)) : on ? [id] : current));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAnswer) return;
    const draft = taskListDraft(props, props.mode === 'multiSelect' ? selected : selected[0]);
    if (!draft.ok) return setError(Object.values(draft.errors)[0] ?? 'Pick one task.');
    setError(undefined);
    onAnswer(draft.answer);
  };
  const answeredText =
    answer === undefined
      ? undefined
      : props.mode === 'multiSelect' && 'taskIds' in answer
        ? `Chosen: ${taskLabels(props, answer.taskIds)}`
        : 'taskId' in answer
          ? `Chosen: ${taskLabel(props, answer.taskId) ?? answer.taskId}`
          : undefined;
  return (
    <CardFrame kind="task-list" title={props.title} detail={props.detail} status={status} busy={busy} onDismiss={onDismiss}>
      <form className="space-y-2" onSubmit={submit}>
        <TaskListRows props={props} selected={selected} selectable={selectable} locked={locked} errorId={errorId} error={error} onToggle={toggle} />
        <FieldError id={errorId} message={error} />
        {status === 'pending' && (
          <div className="space-y-1">
            {props.mode === 'multiSelect' && bounds && (
              <p className="text-xs text-muted-foreground" data-task-counter>
                {`${selected.length} of ${bounds.max} selected`}
              </p>
            )}
            <div className="flex gap-2">
              {selectable ? (
                <Button type="submit" size="sm" disabled={locked || !inBounds}>
                  Choose
                </Button>
              ) : (
                // Display-only: closing answers nothing (dismiss), so the card always has a way out.
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => onDismiss?.()}
                  data-action="close"
                >
                  Close
                </Button>
              )}
            </div>
          </div>
        )}
        {status === 'answered' && answeredText !== undefined && (
          <p className="text-xs text-muted-foreground" data-card-answer>
            {answeredText}
          </p>
        )}
      </form>
    </CardFrame>
  );
}

/** The task list card definition for the assistant registry (the spec is a frontend tool). */
export const taskListDefinitions: WidgetDefinition[] = [
  { ...taskListSpec, component: TaskListCard },
] as WidgetDefinition[];
