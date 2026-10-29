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

  // S4: the duplicate-task-id props check pinned on its own. The fixture carries every other
  // required field (title, valid ids/titles/statuses) and only the duplicate id is wrong, and the
  // near-identical unique-id fixture parses true — so removing the superRefine dup check (mutant
  // M21) fails this test, not just fixtures that fail for unrelated reasons.
  it('props reject duplicate task ids on an otherwise-valid fixture (S4)', () => {
    const withDupes = { title: 'Dupe check', mode: 'display', tasks: [{ id: 't-1', title: 'A' }, { id: 't-1', title: 'B' }] };
    assert.equal(taskListPropsSafe(withDupes), false);
    const parsed = taskListSpec.propsSchema.safeParse(withDupes);
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(parsed.error.issues.some((i) => i.message === 'duplicate_id' && i.path.join('.') === 'tasks'));
    }
    assert.equal(taskListPropsSafe({ ...withDupes, tasks: [{ id: 't-1', title: 'A' }, { id: 't-2', title: 'B' }] }), true); // same fixture, unique ids
    assert.equal(taskListPropsSafe({ ...withDupes, mode: 'multiSelect' }), false); // dupes fail in multiSelect too
  });

  // S6 (#193): `tasks.min(1)` is the wall - the card can never show an empty list, so the tool
  // description must send the agent to a text answer instead of a doomed call (listMyTasks side is
  // pinned in packages/mastra chat-task-tools.test.ts).
  it('S6: the spec description sends an empty list to a text answer (tasks.min(1) is the wall)', () => {
    assert.match(taskListSpec.description, /at least one task/);
    assert.match(taskListSpec.description, /if listMyTasks returns no tasks, do not call it/);
    assert.match(taskListSpec.description, /answer in plain text/);
    assert.equal(taskListPropsSafe({ ...DISPLAY, tasks: [] }), false); // the card really cannot take an empty list
  });

  // S7 (#193, askForm WID-MS pattern): selection bounds belong to multiSelect; display and picker
  // cards refuse minSelected/maxSelected instead of accepting them silently.
  it('S7: display and picker cards refuse minSelected/maxSelected (mode: multi_select_only)', () => {
    const issueStrings = (props: unknown) => {
      const parsed = taskListSpec.propsSchema.safeParse(props);
      return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    assert.deepEqual(issueStrings({ ...DISPLAY, minSelected: 1 }), ['mode: multi_select_only']);
    assert.deepEqual(issueStrings({ ...PICKER, maxSelected: 2 }), ['mode: multi_select_only']);
    assert.deepEqual(issueStrings({ ...PICKER, minSelected: 0, maxSelected: 2 }), ['mode: multi_select_only']);
    assert.equal(taskListPropsSafe({ ...DISPLAY, minSelected: 1 }), false);
    assert.deepEqual(issueStrings({ ...MULTI, minSelected: 1, maxSelected: 2 }), []); // bounds stay fine on multiSelect
    assert.equal(taskListPropsSafe(PICKER), true); // a picker without bounds is untouched
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

  // S3: the picker branch's membership check pinned. An unknown id must be refused by the client
  // draft BEFORE submit (not just by the server), and an offered id must pass — so deleting the
  // `!ids.includes(single)` check (mutant M19) fails this test.
  it('the picker draft refuses task ids outside the offered list (S3)', () => {
    assert.deepEqual(taskListDraft(PICKER, 't-9'), { ok: false, errors: { taskId: 'Pick one task.' } });
    assert.deepEqual(taskListDraft(PICKER, ['t-9']), { ok: false, errors: { taskId: 'Pick one task.' } }); // array-shaped draft too
    assert.deepEqual(taskListDraft(PICKER, 't-2'), { ok: true, answer: { taskId: 't-2' } });
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

  // S2: the Submit gate `disabled={locked || !inBounds}` pinned from the card. A pending card whose
  // draft is out of bounds must render Choose disabled (kills a mutant that drops `|| !inBounds`,
  // and one that changes the multiSelect min default); a pending multiSelect with minSelected: 0 is
  // in bounds with an empty draft and must render Choose ENABLED (kills "always disabled" and
  // `>=`→`>` mutants); and a locked pending card (no onAnswer) renders Choose disabled even when
  // its draft is in bounds (pins the `locked` half of the gate).
  const chooseButtonTag = (html: string) => (html.match(/<button[^>]*>Choose<\/button>/) ?? [undefined])[0];
  it('Submit stays disabled until the selection is in bounds, and enabled once it is (S2)', () => {
    const pickerPending = chooseButtonTag(card(PICKER, 'pending')); // picker: nothing picked -> out of bounds
    assert.ok(pickerPending, 'pending picker renders Choose');
    assert.match(pickerPending!, /\sdisabled=""/); // the attribute, not the word: the Button class also contains 'disabled:'
    const multiPending = chooseButtonTag(card(MULTI, 'pending')); // multiSelect: 0 < default min 1 -> out of bounds
    assert.ok(multiPending, 'pending multiSelect renders Choose');
    assert.match(multiPending!, /\sdisabled=""/);
    const inBounds = chooseButtonTag(card({ ...MULTI, minSelected: 0 }, 'pending')); // 0 >= min 0, 0 <= max -> in bounds
    assert.ok(inBounds, 'in-bounds multiSelect renders Choose');
    assert.doesNotMatch(inBounds!, /\sdisabled=""/);
    const lockedInBounds = ((): string | undefined => {
      const html = renderToStaticMarkup(
        React.createElement(TaskListCard, { toolCallId: 'c1', props: { ...MULTI, minSelected: 0 }, status: 'pending', onDismiss: () => undefined }),
      );
      return chooseButtonTag(html);
    })(); // in bounds but locked (no onAnswer)
    assert.ok(lockedInBounds, 'locked pending card still renders Choose');
    assert.match(lockedInBounds!, /\sdisabled=""/);
  });

  // S5 (a11y): the picker radios must be ONE radio group — a single shared name across the rows
  // (ChoiceCard's pattern), not the old per-row `${task.id}-one`. Also pins the multiSelect
  // checkboxes onto the shared `-multi` name.
  it('picker radios share one radio-group name; checkboxes share one name (S5)', () => {
    const inputNames = (html: string, type: string): string[] =>
      [...html.matchAll(/<input([^>]*?)>/g)]
        .map((m) => m[1])
        .filter((attrs) => attrs.includes(`type="${type}"`))
        .map((attrs) => /name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const radios = inputNames(card(PICKER, 'pending'), 'radio');
    assert.equal(radios.length, 2);
    assert.equal(new Set(radios).size, 1); // one group: both rows carry the same name
    assert.ok(radios[0]!.length > 0 && !radios[0]!.includes('t-1') && !radios[0]!.includes('t-2')); // shared, not per-row
    const boxes = inputNames(card(MULTI, 'pending'), 'checkbox');
    assert.equal(boxes.length, 2);
    assert.equal(new Set(boxes).size, 1);
    assert.ok(boxes[0]!.endsWith('-multi')); // same naming convention as ChoiceCard
  });

  // S193-S9 (#193; S5 follow-up from #200): S5 pins the shared name WITHIN a card, but a constant
  // name would pass that too. useId uniqueness is the other half: two picker cards in ONE tree
  // must get DIFFERENT radio-group names, or the pickers on a page collapse into one radio group.
  // renderToStaticMarkup restarts the id counter on every call, so both cards must go through a
  // single render. Mutant: `React.useId()` -> a constant string -> RED here, still green in S5.
  it('two pickers in one tree get distinct radio-group names (S193-S9, useId uniqueness)', () => {
    const inputNames = (html: string, type: string): string[] =>
      [...html.matchAll(/<input([^>]*?)>/g)]
        .map((m) => m[1])
        .filter((attrs) => attrs.includes(`type="${type}"`))
        .map((attrs) => /name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const html = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(TaskListCard, { toolCallId: 'c1', props: PICKER, status: 'pending', onAnswer: () => undefined, onDismiss: () => undefined }),
        React.createElement(TaskListCard, { toolCallId: 'c2', props: PICKER, status: 'pending', onAnswer: () => undefined, onDismiss: () => undefined }),
      ),
    );
    const radios = inputNames(html, 'radio');
    assert.equal(radios.length, 4); // 2 rows per card, 2 cards
    const cardOne = radios.slice(0, 2);
    const cardTwo = radios.slice(2, 4);
    assert.equal(new Set(cardOne).size, 1); // each card is still ONE radio group (the S5 invariant)
    assert.equal(new Set(cardTwo).size, 1);
    assert.ok(cardOne[0]!.length > 0 && cardTwo[0]!.length > 0); // names actually render
    assert.notEqual(cardOne[0], cardTwo[0]); // the two cards do not share a group name
  });

  it('an answered card locks and replays the chosen tasks; a dismissed card says so', () => {
    assert.match(card(PICKER, 'answered', { taskId: 't-2' }), /Chosen: Check the restore backup/);
    assert.match(card(MULTI, 'answered', { taskIds: ['t-1', 't-2'] }), /Chosen: Draft the runbook, Check the restore backup/);
    const dismissed = card(DISPLAY, 'dismissed');
    assert.match(dismissed, /Dismissed without an answer\./);
    assert.doesNotMatch(dismissed, /data-action="close"/); // Close renders only while pending
    assert.doesNotMatch(dismissed, /type="radio"|type="checkbox"/); // display mode renders no inputs at all
  });

  // B1: picker/multiSelect inputs still render (so the replayed selection shows) but the fieldset is disabled
  // once the card is answered or dismissed; a pending card with a handler stays interactive.
  const fieldsetDisabled = (html: string) => /<fieldset[^>]*\sdisabled=""/.test(html);
  it('picker and multiSelect lock their fieldset when answered or dismissed (pending stays enabled)', () => {
    assert.equal(fieldsetDisabled(card(PICKER, 'pending')), false);
    assert.equal(fieldsetDisabled(card(MULTI, 'pending')), false);

    const pickerAnswered = card(PICKER, 'answered', { taskId: 't-2' });
    assert.equal(fieldsetDisabled(pickerAnswered), true);
    assert.match(pickerAnswered, /<input type="radio"[^>]*checked=""[^>]*value="t-2"/); // replayed selection still shown
    const pickerDismissed = card(PICKER, 'dismissed');
    assert.equal(fieldsetDisabled(pickerDismissed), true);
    assert.match(pickerDismissed, /type="radio"/);

    const multiAnswered = card({ ...MULTI, minSelected: 1, maxSelected: 2 }, 'answered', { taskIds: ['t-1', 't-2'] });
    assert.equal(fieldsetDisabled(multiAnswered), true);
    assert.equal((multiAnswered.match(/type="checkbox"[^>]*checked=""/g) ?? []).length, 2);
    const multiDismissed = card(MULTI, 'dismissed');
    assert.equal(fieldsetDisabled(multiDismissed), true);
    assert.match(multiDismissed, /type="checkbox"/);
  });

  it('a pending picker with no answer handler is locked too', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskListCard, { toolCallId: 'c1', props: PICKER, status: 'pending', onDismiss: () => undefined }),
    );
    assert.equal(fieldsetDisabled(html), true);
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
