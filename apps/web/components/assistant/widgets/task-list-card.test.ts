/**
 * TASK-LIST-WID: the task list card — props and answers per mode (display / picker / multiSelect),
 * the draft helpers behind the card, and the component path through the assistant registry:
 * a `showTaskList` tool call resolves to TaskListCard (not the fallback card), renders its modes
 * pending / answered / dismissed, and replays a stored answer. No DOM test library: react-dom/server
 * markup, like chat-cards.test.ts.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { acceptWidgetAnswer } from '@tourbillon/shared/widgets';
import { taskListSpec, checkTaskListAnswer, type TaskListAnswer, type TaskListProps } from './task-list-specs';
import { checkedTaskIds, initialTaskListDraft, taskLabel, taskLabels, taskListBounds, taskListDraft } from './task-list-drafts';

type Tool = typeof import('./widget-tool-call');
type Reg = typeof import('./registry');
let WidgetToolCall: Tool['WidgetToolCall'];
let registry: Reg['assistantWidgetRegistry'];

const TASKS = [
  { id: 't-1', title: 'Draft the runbook', status: 'in_progress' as const },
  { id: 't-2', title: 'Check the restore backup', status: 'pending' as const, notes: 'notify: Ops' },
];
const DISPLAY: TaskListProps = { title: 'What I am working on', mode: 'display', tasks: TASKS };
const PICKER: TaskListProps = { ...DISPLAY, mode: 'picker' };
const MULTI: TaskListProps = { ...DISPLAY, mode: 'multiSelect' };

const check = (props: unknown, answer: unknown) => {
  const r = acceptWidgetAnswer(taskListSpec as never, 'c1', answer, new Date(0), props);
  return r.ok ? 'ok' : r.issues;
};

// The card module is client-only in the app (tsx compiles it fine); keep the loads lazy like chat-cards.test.ts.
before(async () => {
  (globalThis as { React?: unknown }).React = React; // button.tsx renders through the classic JSX transform
  const toolCall = await import('./widget-tool-call');
  const reg = await import('./registry');
  WidgetToolCall = toolCall.WidgetToolCall;
  registry = reg.assistantWidgetRegistry;
});

describe('TASK-LIST-WID task list spec', () => {
  it('registered as a frontend tool and resolves through the assistant registry', () => {
    assert.equal(taskListSpec.frontendTool, true);
    const resolved = registry.resolve({ toolCallId: 'c1', toolName: 'showTaskList', args: { ...DISPLAY } });
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.definition.component.name, 'TaskListCard');
    // A call for a version the registry does not have falls back (and does not throw).
    assert.equal(registry.resolve({ toolCallId: 'c2', toolName: 'showTaskList', args: { ...DISPLAY, widgetVersion: 2 } }).ok, false);
  });

  it('props are validated: modes, statuses and bounds', () => {
    assert.equal(taskListPropsSafe(DISPLAY), true);
    assert.equal(taskListPropsSafe(PICKER), true);
    assert.equal(taskListPropsSafe(MULTI), true);
    assert.equal(taskListPropsSafe({ ...DISPLAY, tasks: [] }), false); // empty list
    assert.equal(taskListPropsSafe({ mode: 'display', tasks: [{ id: 't-1', title: 'x', status: 'assigned' }] }), false); // unknown status
    assert.equal(taskListPropsSafe({ mode: 'display', tasks: [{ id: 't-1', title: 'x' }, { id: 't-1', title: 'y' }] }), false); // duplicate ids
    assert.equal(taskListPropsSafe({ ...MULTI, minSelected: 2, maxSelected: 1 }), false); // unsatisfiable bounds
    assert.equal(taskListPropsSafe({ ...MULTI, maxSelected: 3 }), false); // more than offered
  });

  it('modes enforce the answer shape (client check === server check)', () => {
    // display: read-only; an ack is accepted, a selection is refused.
    assert.equal(check(DISPLAY, { ack: true }), 'ok');
    assert.deepEqual(check(DISPLAY, { taskId: 't-1' }), ['taskId: display_mode']);
    assert.deepEqual(check(DISPLAY, { taskIds: ['t-1'] }), ['taskIds: display_mode']);
    // picker: exactly one offered task.
    assert.equal(check(PICKER, { taskId: 't-1' }), 'ok');
    assert.deepEqual(check(PICKER, { taskId: 't-9' }), ['taskId: not_a_task']);
    assert.deepEqual(check(PICKER, { taskIds: ['t-1'] }), ['taskIds: multi_only']);
    // multiSelect: a de-duplicated list of offered tasks within bounds (default 1..all).
    assert.equal(check(MULTI, { taskIds: ['t-1', 't-2'] }), 'ok');
    assert.deepEqual(check(MULTI, { taskIds: [] }), ['taskIds: too_few']);
    assert.deepEqual(check(MULTI, { taskIds: ['t-1', 't-1'] }), ['taskIds: duplicate_id']);
    assert.deepEqual(check(MULTI, { taskIds: ['t-9'] }), ['taskIds: not_a_task']);
    assert.deepEqual(check(MULTI, { taskIds: ['t-1', 't-2', 't-1'] }), ['taskIds: duplicate_id', 'taskIds: too_many']);
    assert.deepEqual(check(MULTI, { taskIds: ['t-9', 't-9'] }), ['taskIds: duplicate_id', 'taskIds: not_a_task']);
    assert.deepEqual(check(MULTI, { taskId: 't-1' }), ['taskIds: invalid_type']);
    assert.deepEqual(check({ ...MULTI, minSelected: 0 }, { taskIds: [] }), 'ok'); // minSelected: 0 allows an empty submit
    // checkAnswer is pure and safe with a taskIds answer missing from props-like input too.
    assert.deepEqual(checkTaskListAnswer(PICKER, { taskIds: ['t-1'] }), ['taskIds: multi_only']);
  });

  it('taskListDraft gates the UI exactly like checkTaskListAnswer', () => {
    assert.equal(initialTaskListDraft(DISPLAY), undefined);
    assert.equal(initialTaskListDraft(PICKER), undefined); // picker has no preselected task
    assert.deepEqual(initialTaskListDraft(MULTI), []);
    assert.deepEqual(taskListDraft(PICKER, undefined), { ok: false, errors: { taskId: 'Pick one task.' } });
    assert.deepEqual(taskListDraft(PICKER, 't-1'), { ok: true, answer: { taskId: 't-1' } });
    assert.deepEqual(taskListDraft(MULTI, []), { ok: false, errors: { taskIds: 'Choose at least 1 task.' } });
    assert.deepEqual(taskListDraft(MULTI, ['t-1', 't-2']), { ok: true, answer: { taskIds: ['t-1', 't-2'] } });
    assert.deepEqual(taskListDraft(MULTI, ['t-1', 't-1', 't-2', 't-2']), { ok: true, answer: { taskIds: ['t-1', 't-2'] } }); // de-duped before the bounds check, like choiceDraft
    assert.deepEqual(taskListDraft({ ...MULTI, maxSelected: 1 }, ['t-1', 't-2']), { ok: false, errors: { taskIds: 'Choose at most 1 tasks.' } });
    assert.deepEqual(taskListDraft(MULTI, ['t-9']), { ok: false, errors: { taskIds: 'Pick tasks from the list.' } });
    assert.deepEqual(taskListBounds(MULTI), { min: 1, max: 2 });
    assert.equal(taskLabel(DISPLAY, 't-2'), 'Check the restore backup');
    assert.equal(taskLabels(DISPLAY, ['t-1', 't-2']), 'Draft the runbook, Check the restore backup');
  });

  it('an answered card replays the stored answer, not the draft', () => {
    assert.deepEqual(checkedTaskIds('answered', { taskId: 't-2' }, ['t-1']), ['t-2']);
    assert.deepEqual(checkedTaskIds('answered', { taskIds: ['t-1', 't-2'] }, []), ['t-1', 't-2']);
    assert.deepEqual(checkedTaskIds('answered', undefined, ['t-1']), []);
    assert.deepEqual(checkedTaskIds('pending', undefined, []), []);
  });
});

function taskListPropsSafe(props: unknown): boolean {
  return taskListSpec.propsSchema.safeParse(props).success;
}

describe('TASK-LIST-WID task list card', () => {
  let TaskListCard: (typeof import('./task-list-card'))['TaskListCard'];
  let taskListDefinitions: (typeof import('./task-list-card'))['taskListDefinitions'];

  before(async () => {
    TaskListCard = (await import('./task-list-card')).TaskListCard;
    taskListDefinitions = (await import('./task-list-card')).taskListDefinitions;
  });

  const card = (props: TaskListProps, status: 'pending' | 'answered' | 'dismissed', answer?: TaskListAnswer) =>
    renderToStaticMarkup(
      React.createElement(TaskListCard, { toolCallId: 'c1', props, status, answer, onAnswer: () => undefined, onDismiss: () => undefined }),
    );

  it('display renders a read-only list with a Close button and no Submit', () => {
    const html = card(DISPLAY, 'pending');
    assert.match(html, /data-card="task-list"/);
    assert.match(html, /Draft the runbook/);
    assert.match(html, /data-task-status="in_progress"/);
    assert.match(html, /in progress/); // status chip text
    assert.match(html, /notify: Ops/);
    assert.match(html, /data-action="close"/); // Close (dismiss) instead of Submit
    assert.doesNotMatch(html, /name="t-1/); // no radio or checkbox in a read-only list
  });

  it('picker renders radios; multiSelect renders checkboxes with a counter', () => {
    assert.match(card(PICKER, 'pending'), /type="radio"/);
    const multi = card(MULTI, 'pending');
    assert.match(multi, /type="checkbox"/);
    assert.match(multi, /0 of 2 selected/);
  });

  it('an answered card locks and replays the chosen tasks; a dismissed card says so', () => {
    assert.match(card(PICKER, 'answered', { taskId: 't-2' }), /Chosen: Check the restore backup/);
    assert.match(card(MULTI, 'answered', { taskIds: ['t-1', 't-2'] }), /Chosen: Draft the runbook, Check the restore backup/);
    const dismissed = card(DISPLAY, 'dismissed');
    assert.match(dismissed, /Dismissed without an answer\./);
    assert.doesNotMatch(dismissed, /data-action="close"/); // Close renders only while pending
    assert.doesNotMatch(dismissed, /type="radio"|type="checkbox"/); // a replayed dismissed card is locked (disabled fieldset)
  });

  it('a showTaskList tool call renders the card, not the fallback', () => {
    const html = renderToStaticMarkup(
      React.createElement(WidgetToolCall, {
        registry: registry,
        toolCall: { toolCallId: 'c1', toolName: 'showTaskList', args: { ...PICKER } },
        answer: { taskId: 't-1' },
      }),
    );
    assert.match(html, /data-widget="showTaskList"/);
    assert.match(html, /data-widget-status="answered"/);
    assert.match(html, /Chosen: Draft the runbook/);
  });

  it('the definition list registers TaskListCard for the spec (registry <-> specs match)', () => {
    assert.deepEqual(taskListDefinitions.map((d) => [d.name, d.version, d.component.name]), [['showTaskList', 1, 'TaskListCard']]);
  });
});
