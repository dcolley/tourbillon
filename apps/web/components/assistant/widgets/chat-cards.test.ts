/**
 * WID-3: question, choice, form and confirm cards — specs (props / answers refused outside the card,
 * credential-like form fields refused), the draft helpers behind each card, the registry's client-side
 * check (same as the server's), and rendering of each card pending / answered / dismissed / busy,
 * with agent text shown as text only. No DOM test library in the repo: react-dom/server markup.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { acceptWidgetAnswer } from '@tourbillon/shared/widgets';
import {
  askChoiceSpec,
  askConfirmSpec,
  askFormSpec,
  askQuestionSpec,
  type AskChoiceProps,
  type AskConfirmProps,
  type AskFormProps,
} from './chat-card-specs';
import { choiceDraft, confirmDraft, formDraft, formValueText, initialChoice, initialChoiceDraft, initialFormDraft, questionDraft } from './chat-card-drafts';

type Tool = typeof import('./widget-tool-call');
type Reg = typeof import('./registry');
let WidgetToolCall: Tool['WidgetToolCall'];
let registry: Reg['assistantWidgetRegistry'];
let createWidgetRegistry: Reg['createWidgetRegistry'];

const CHOICE: AskChoiceProps = {
  question: 'Which plan?',
  options: [
    { id: 'basic', label: 'Basic' },
    { id: 'pro', label: 'Pro', description: 'More seats' },
  ],
  recommended: 'pro',
};
const FORM: AskFormProps = {
  title: 'New project',
  fields: [
    { name: 'projectName', label: 'Name', type: 'text', maxLength: 10 },
    { name: 'seats', label: 'Seats', type: 'number', min: 1, max: 50, integer: true },
    { name: 'tier', label: 'Tier', type: 'select', options: [{ value: 'a', label: 'Tier A' }, { value: 'b', label: 'Tier B' }] },
    { name: 'notes', label: 'Notes', type: 'text', required: false, multiline: true },
  ],
};
const CONFIRM: AskConfirmProps = { question: 'Archive the board?', reason: 'required', confirmLabel: 'Archive', destructive: true };

const issues = (props: unknown, spec: { propsSchema: { safeParse(v: unknown): any } }) => {
  const r = spec.propsSchema.safeParse(props);
  return r.success ? [] : r.error.issues.map((i: { path: PropertyKey[]; message: string; code: string }) => `${i.path.join('.')}: ${i.code === 'custom' ? i.message : i.code}`);
};

describe('WID-3 card specs', () => {
  it('valid props pass; bad option references, duplicates and mixed field settings are refused', () => {
    assert.deepEqual(issues(CHOICE, askChoiceSpec), []);
    assert.deepEqual(issues(FORM, askFormSpec), []);
    assert.deepEqual(issues({ ...CHOICE, recommended: 'gold' }, askChoiceSpec), ['recommended: not_an_option']);
    assert.deepEqual(issues({ ...CHOICE, defaultOption: 'gold' }, askChoiceSpec), ['defaultOption: not_an_option']);
    assert.deepEqual(issues({ ...CHOICE, recommended: undefined, options: [CHOICE.options[0], CHOICE.options[0]] }, askChoiceSpec), ['options: duplicate_id']);
    assert.deepEqual(issues({ ...CHOICE, recommended: undefined, options: [CHOICE.options[0]] }, askChoiceSpec), ['options: too_small']);
    const field = (f: Record<string, unknown>) => ({ title: 't', fields: [{ name: 'x', label: 'X', ...f }] });
    assert.deepEqual(issues(field({ type: 'select' }), askFormSpec), ['fields.0.options: required_for_select']);
    assert.deepEqual(issues(field({ type: 'text', options: [{ value: 'a', label: 'A' }] }), askFormSpec), ['fields.0.options: select_only']);
    assert.deepEqual(issues(field({ type: 'text', min: 1 }), askFormSpec), ['fields.0.type: number_only']);
    assert.deepEqual(issues(field({ type: 'number', min: 5, max: 1 }), askFormSpec), ['fields.0.min: min_above_max']);
    assert.deepEqual(issues({ title: 't', fields: [FORM.fields[0], FORM.fields[0]] }, askFormSpec), ['fields: duplicate_name']);
    assert.deepEqual(issues({ ...CHOICE, html: '<b>' }, askChoiceSpec), [': unrecognized_keys']);
  });

  it('forms cannot ask for passwords, tokens, keys or other credentials', () => {
    for (const [name, label] of [
      ['password', 'Password'],
      ['apiKey', 'Key'],
      ['note', 'Your access token'],
      ['otpCode', 'Code'],
      ['secretAnswer', 'Answer'],
      ['pin', 'PIN'],
    ]) {
      assert.deepEqual(issues({ title: 't', fields: [{ name, label, type: 'text' }] }, askFormSpec), ['fields.0.name: credential_field'], name);
    }
    assert.deepEqual(issues({ title: 't', fields: [{ name: 'spinCount', label: 'Spins', type: 'number' }] }, askFormSpec), []);
  });

  it('near-miss credential fields are refused; look-alike harmless names are not', () => {
    for (const [name, label] of [
      ['pinCode', 'Code'],
      ['pin_code', 'Code'],
      ['pwd', 'Value'],
      ['cardCheck', 'Card CVV'],
      ['awsKeyId', 'Access key'],
      ['mfa', 'MFA code'],
      ['note', 'p\u0430ssword'], // Cyrillic "а"
      ['userPassword', 'Login'],
      ['verify', 'Verification code'],
      ['devicePasscode', 'Passcode'], // a passcode is a secret code: refused on purpose
      ['wallet', 'Seed phrase'],
    ]) {
      assert.deepEqual(issues({ title: 't', fields: [{ name, label, type: 'text' }] }, askFormSpec), ['fields.0.name: credential_field'], `${name}/${label}`);
    }
    for (const [name, label] of [
      ['passportNumber', 'Passport number'],
      ['compassHeading', 'Compass heading'],
      ['footprint', 'Footprint'],
      ['spinCount', 'Spins'],
      ['pinnedNote', 'Pinned note'],
    ]) {
      assert.deepEqual(issues({ title: 't', fields: [{ name, label, type: 'text' }] }, askFormSpec), [], `${name}/${label}`);
    }
  });

  it('credential-shaped questions, titles, placeholders and option labels are refused', () => {
    assert.deepEqual(issues({ question: 'What is your password?' }, askQuestionSpec), ['question: credential_text']);
    assert.deepEqual(issues({ question: 'Paste the API key here' }, askQuestionSpec), ['question: credential_text']);
    assert.deepEqual(issues({ question: 'Code?', placeholder: 'One-time code from your app' }, askQuestionSpec), ['placeholder: credential_text']);
    assert.deepEqual(issues({ ...CHOICE, question: 'Which MFA code did you get?' }, askChoiceSpec), ['question: credential_text']);
    assert.deepEqual(
      issues({ ...CHOICE, recommended: undefined, options: [{ id: 'a', label: 'Use my token' }, { id: 'b', label: 'Basic' }] }, askChoiceSpec),
      ['options.0.label: credential_text'],
    );
    assert.deepEqual(issues({ ...FORM, title: 'Enter your credentials' }, askFormSpec), ['title: credential_text']);
    assert.deepEqual(
      issues({ title: 't', fields: [{ name: 'tier', label: 'Tier', type: 'select', options: [{ value: 'a', label: 'CVV 123' }] }] }, askFormSpec),
      ['fields.0.options.0.label: credential_text'],
    );
    // Prose that only mentions common words is fine.
    assert.deepEqual(issues({ question: 'Which token budget should the run use?' }, askQuestionSpec), []);
    assert.deepEqual(issues({ question: 'Should I pin this issue or authorize the deploy?' }, askQuestionSpec), []);
    assert.deepEqual(issues({ question: 'Which passport office and compass heading?' }, askQuestionSpec), []);
  });

  it('multiSelect (WID-MS): one card carries a list answer (bounds, dupes, membership); a multiSelect field takes string[]', () => {
    const now = new Date(0);
    const check = (spec: any, props: unknown, answer: unknown) => {
      const r = acceptWidgetAnswer(spec, 'c1', answer, now, props);
      return r.ok ? 'ok' : r.issues;
    };
    const MULTI = { ...CHOICE, recommended: undefined, multiSelect: true };
    const MULTI_MAX1 = { ...MULTI, maxSelected: 1 };
    const MULTI_MIN0 = { ...MULTI, minSelected: 0 };
    // A multi-select card answers with the chosen ids; single-select keeps { choice } and refuses a list.
    assert.deepEqual(check(askChoiceSpec, MULTI, { choices: ['basic', 'pro'] }), 'ok'); // default max = every option
    assert.deepEqual(check(askChoiceSpec, MULTI_MIN0, { choices: [] }), 'ok'); // minSelected: 0 allows an empty submit
    assert.deepEqual(check(askChoiceSpec, MULTI, { choices: [] }), ['choices: too_few']); // default minSelected is 1
    assert.deepEqual(check(askChoiceSpec, MULTI_MAX1, { choices: ['basic', 'pro'] }), ['choices: too_many']);
    assert.deepEqual(check(askChoiceSpec, MULTI, { choices: ['basic', 'basic'] }), ['choices: duplicate_id']);
    assert.deepEqual(check(askChoiceSpec, MULTI, { choices: ['gold'] }), ['choices: not_an_option']);
    assert.deepEqual(check(askChoiceSpec, MULTI, { choices: ['gold', 'gold'] }), ['choices: duplicate_id', 'choices: not_an_option']);
    assert.deepEqual(check(askChoiceSpec, CHOICE, { choices: ['basic'] }), ['choices: multi_only']); // a single-select card takes one option
    assert.deepEqual(check(askChoiceSpec, MULTI, { choice: 'basic' }), ['choices: invalid_type']); // a multi-select card takes a list
    // Props-side: recommended may be a list (highlighted, never preselected) and bounds are validated on props.
    assert.deepEqual(issues(MULTI, askChoiceSpec), []);
    assert.deepEqual(issues({ ...MULTI, recommended: ['gold', 'pro'] }, askChoiceSpec), ['recommended: not_an_option']);
    assert.deepEqual(issues({ ...MULTI, maxSelected: 3 }, askChoiceSpec), ['maxSelected: max_above_options']); // only two options offered
    assert.deepEqual(issues({ ...MULTI, minSelected: 3, maxSelected: 2 }, askChoiceSpec), ['minSelected: min_above_max']);
    // askForm: a multiSelect field answers with a string[] of offered option values.
    const TAGS = { name: 'tags', label: 'Tags', type: 'multiSelect' as const, options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }] };
    const formProps = { title: 't', fields: [TAGS] };
    assert.deepEqual(issues(formProps, askFormSpec), []);
    assert.deepEqual(issues({ title: 't', fields: [{ ...TAGS, minSelected: 2, maxSelected: 1 }] }, askFormSpec), ['fields.0.minSelected: min_above_max']);
    assert.deepEqual(issues({ title: 't', fields: [{ ...TAGS, maxSelected: 4 }] }, askFormSpec), ['fields.0.maxSelected: max_above_options']);
    assert.deepEqual(issues({ title: 't', fields: [{ name: 'x', label: 'X', type: 'multiSelect' as const }] }, askFormSpec), ['fields.0.options: required_for_select']);
    assert.deepEqual(check(askFormSpec, formProps, { values: { tags: ['x', 'z'] } }), 'ok');
    assert.deepEqual(check(askFormSpec, formProps, { values: { tags: 'x' } }), ['values.tags: invalid_type']);
    assert.deepEqual(check(askFormSpec, formProps, { values: { tags: ['x', 'x'] } }), ['values.tags: duplicate_value']);
    assert.deepEqual(check(askFormSpec, formProps, { values: { tags: ['q'] } }), ['values.tags: not_an_option']);
    assert.deepEqual(check(askFormSpec, formProps, { values: { tags: [] } }), ['values.tags: required']);
    assert.deepEqual(check(askFormSpec, { title: 't', fields: [{ ...TAGS, required: false }] }, { values: { tags: [] } }), 'ok');
    assert.deepEqual(check(askFormSpec, { title: 't', fields: [{ ...TAGS, maxSelected: 2 }] }, { values: { tags: ['x', 'y', 'z'] } }), ['values.tags: too_many']);
  });

  it('answers are checked against the props the card was asked with', () => {
    const now = new Date(0);
    const check = (spec: any, props: unknown, answer: unknown) => {
      const r = acceptWidgetAnswer(spec, 'c1', answer, now, props);
      return r.ok ? 'ok' : r.issues;
    };
    assert.equal(check(askChoiceSpec, CHOICE, { choice: 'pro' }), 'ok');
    assert.deepEqual(check(askChoiceSpec, CHOICE, { choice: 'gold' }), ['choice: not_an_option']);
    assert.equal(check(askQuestionSpec, { question: 'q', maxLength: 5 }, { text: 'short' }), 'ok');
    assert.deepEqual(check(askQuestionSpec, { question: 'q', maxLength: 5 }, { text: 'longer' }), ['text: too_long']);
    assert.deepEqual(check(askQuestionSpec, { question: 'q' }, { text: '   ' }), ['text: too_small']);
    assert.equal(check(askFormSpec, FORM, { values: { projectName: 'Orbit', seats: 3, tier: 'a', notes: null } }), 'ok');
    assert.deepEqual(check(askFormSpec, FORM, { values: { projectName: 'Orbit', seats: 3, tier: 'a' } }), 'ok');
    assert.deepEqual(check(askFormSpec, FORM, { values: { projectName: 'A very long name', seats: 0, tier: 'c', x: 1 } }), [
      'values.x: unknown_field',
      'values.projectName: too_long',
      'values.seats: too_small',
      'values.tier: not_an_option',
    ]);
    assert.equal(check(askConfirmSpec, CONFIRM, { confirmed: true, reason: 'Done' }), 'ok');
    assert.deepEqual(check(askConfirmSpec, CONFIRM, { confirmed: true }), ['reason: required']);
    assert.deepEqual(check(askConfirmSpec, { question: 'q' }, { confirmed: true, reason: 'x' }), ['reason: not_asked']);
    assert.equal(check(askConfirmSpec, { question: 'q', reason: 'optional' }, { confirmed: false }), 'ok');
  });

  it('fails closed: an answer cannot be accepted without valid props', () => {
    assert.deepEqual(acceptWidgetAnswer(askChoiceSpec as any, 'c1', { choice: 'pro' }), { ok: false, issues: ['(props): unavailable'] });
    assert.deepEqual(acceptWidgetAnswer(askChoiceSpec as any, 'c1', { choice: 'pro' }, new Date(), { question: '' }), {
      ok: false,
      issues: ['(props): invalid'],
    });
  });
});

describe('WID-3 card drafts', () => {
  it('multiSelect drafts (WID-MS): the card and the form field hold lists; out-of-bounds picks refuse to submit', () => {
    const multi = { ...CHOICE, multiSelect: true, maxSelected: 1 };
    assert.deepEqual(initialChoiceDraft(multi), []); // recommended is a hint, never a preselection
    assert.equal(initialChoiceDraft(CHOICE), undefined);
    assert.equal(initialChoiceDraft({ ...CHOICE, defaultOption: 'basic' }), 'basic');
    assert.deepEqual(choiceDraft(multi, ['basic']), { ok: true, answer: { choices: ['basic'] } });
    assert.equal(choiceDraft(multi, ['basic', 'pro']).ok, false); // maxSelected: 1 refuses two picks
    assert.equal(choiceDraft(multi, []).ok, false); // under minSelected
    assert.deepEqual(choiceDraft(CHOICE, ['gold']), { ok: false, errors: { choice: 'Pick one option.' } });
    const field = { name: 'tags', label: 'Tags', type: 'multiSelect' as const, options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] };
    const props = { title: 't', fields: [field] };
    const propsMax1 = { title: 't', fields: [{ ...field, maxSelected: 1 }] };
    assert.deepEqual(initialFormDraft(props), { tags: [] });
    assert.deepEqual(formDraft(props, { tags: ['x'] }), { ok: true, answer: { values: { tags: ['x'] } } });
    assert.equal(formDraft(props, { tags: [] }).ok, false); // a required multiSelect field refuses to submit empty
    assert.equal(formDraft(propsMax1, { tags: ['x', 'y'] }).ok, false); // over maxSelected
    assert.equal(formValueText(field, ['x', 'y']), 'X, Y'); // the answered card lists every chosen label
  });

  it('question: trimmed text, empty and too long refused', () => {
    assert.deepEqual(questionDraft('  hi  '), { ok: true, answer: { text: 'hi' } });
    assert.equal(questionDraft('   ').ok, false);
    assert.equal(questionDraft('abcdef', 5).ok, false);
  });

  it('choice: default preselected, a pick must be an option', () => {
    assert.equal(initialChoice(CHOICE), undefined);
    assert.equal(initialChoice({ ...CHOICE, defaultOption: 'basic' }), 'basic');
    assert.deepEqual(choiceDraft(CHOICE, 'pro'), { ok: true, answer: { choice: 'pro' } });
    assert.equal(choiceDraft(CHOICE, undefined).ok, false);
    assert.equal(choiceDraft(CHOICE, 'gold').ok, false);
  });

  it('form: typed text becomes values (numbers parsed, empty optional → null); errors per field', () => {
    assert.deepEqual(initialFormDraft(FORM), { projectName: '', seats: '', tier: '', notes: '' });
    assert.deepEqual(formDraft(FORM, { projectName: ' Orbit ', seats: '7', tier: 'b', notes: '' }), {
      ok: true,
      answer: { values: { projectName: 'Orbit', seats: 7, tier: 'b', notes: null } },
    });
    assert.deepEqual(formDraft(FORM, { projectName: '', seats: '2.5', tier: '', notes: '' }), {
      ok: false,
      errors: { projectName: 'Required.', seats: 'Enter a whole number.', tier: 'Required.' },
    });
    assert.deepEqual(formDraft(FORM, { projectName: 'x', seats: '99', tier: 'a', notes: '' }), { ok: false, errors: { seats: 'At most 50.' } });
    assert.deepEqual(formDraft(FORM, { projectName: 'x', seats: 'abc', tier: 'a', notes: '' }), { ok: false, errors: { seats: 'Enter a valid value.' } });
  });

  it('confirm: reason only when asked, required reason enforced', () => {
    assert.deepEqual(confirmDraft({ question: 'q' }, true, 'ignored'), { ok: true, answer: { confirmed: true } });
    assert.deepEqual(confirmDraft(CONFIRM, false, '  '), { ok: false, errors: { reason: 'Give a reason.' } });
    assert.deepEqual(confirmDraft(CONFIRM, false, ' Not yet '), { ok: true, answer: { confirmed: false, reason: 'Not yet' } });
    assert.deepEqual(confirmDraft({ question: 'q', reason: 'optional' }, true, ''), { ok: true, answer: { confirmed: true } });
  });
});

describe('WID-3 card rendering', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ WidgetToolCall } = await import('./widget-tool-call'));
    ({ assistantWidgetRegistry: registry, createWidgetRegistry } = await import('./registry'));
  });

  const render = (toolName: string, args: unknown, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      React.createElement(WidgetToolCall, {
        registry,
        toolCall: { toolCallId: 'c1', toolName, args },
        onAnswer: () => {},
        onDismiss: () => {},
        ...extra,
      }),
    );

  it('question: pending input with Send answer and Dismiss; answered shows the text; multiline uses a textarea', () => {
    const html = render('askQuestion', { question: 'What changed?', placeholder: 'Describe it', detail: 'Short is fine.' });
    assert.match(html, /data-card="question"/);
    assert.match(html, /What changed\?/);
    assert.match(html, /Short is fine\./);
    assert.match(html, /<input[^>]*placeholder="Describe it"/);
    assert.match(html, /Send answer/);
    assert.match(html, /data-action="dismiss"/);
    assert.match(render('askQuestion', { question: 'q', multiline: true }), /<textarea/);
    const answered = render('askQuestion', { question: 'q' }, { answer: { text: 'All good' } });
    assert.match(answered, /data-card-status="answered"/);
    assert.match(answered, /All good/);
    assert.doesNotMatch(answered, /Send answer|data-action="dismiss"/);
  });

  it('choice: options as radios with descriptions, the recommended one marked, the default checked', () => {
    const html = render('askChoice', { ...CHOICE, defaultOption: 'basic' });
    assert.match(html, /data-card="choice"/);
    assert.equal(html.match(/type="radio"/g)?.length, 2);
    assert.match(html, /data-option="pro" data-recommended="true"/);
    assert.match(html, /Recommended/);
    assert.match(html, /More seats/);
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="basic"/);
    const answered = render('askChoice', CHOICE, { answer: { choice: 'pro' } });
    assert.match(answered, /<fieldset[^>]*disabled/);
    assert.match(answered, /Chosen: Pro/);
  });

  it('form: text, number and select inputs with labels; optional marked; answered shows the values', () => {
    const html = render('askForm', FORM);
    assert.match(html, /data-card="form"/);
    assert.match(html, /data-field="projectName" data-field-type="text"/);
    assert.match(html, /<input[^>]*type="number"[^>]*min="1"[^>]*max="50"/);
    assert.match(html, /<select[^>]*name="tier"/);
    assert.match(html, /<option value="b">Tier B<\/option>/);
    assert.match(html, /<textarea[^>]*name="notes"/);
    assert.match(html, /\(optional\)/);
    assert.match(html, />Submit</);
    const answered = render('askForm', FORM, { answer: { values: { projectName: 'Orbit', seats: 5, tier: 'b', notes: null } } });
    assert.match(answered, /<dd[^>]*>Orbit<\/dd>/);
    assert.match(answered, /<dd[^>]*>Tier B<\/dd>/);
    assert.match(answered, /<dd[^>]*>—<\/dd>/);
    assert.doesNotMatch(answered, /<input|<select/);
  });

  it('confirm: custom labels, reason box when asked; answered shows the outcome and reason', () => {
    const html = render('askConfirm', CONFIRM);
    assert.match(html, /data-card="confirm"/);
    assert.match(html, />Archive</);
    assert.match(html, />Cancel</);
    assert.match(html, /<textarea/);
    assert.doesNotMatch(render('askConfirm', { question: 'Go?' }), /<textarea/);
    const answered = render('askConfirm', CONFIRM, { answer: { confirmed: false, reason: 'Still used' } });
    assert.match(answered, /data-confirmed="false"/);
    assert.match(answered, />Cancel(led)?</);
    assert.match(answered, /Still used/);
  });

  it('dismissed, busy and not-answerable cards are locked', () => {
    const dismissed = render('askChoice', CHOICE, { dismissed: true });
    assert.match(dismissed, /data-card-status="dismissed"/);
    assert.match(dismissed, /Dismissed without an answer\./);
    assert.match(dismissed, /<fieldset[^>]*disabled/);
    const busy = render('askQuestion', { question: 'q' }, { busy: true });
    assert.match(busy, /Sending…/);
    assert.match(busy, /<input[^>]*disabled/);
    assert.doesNotMatch(busy, /data-action="dismiss"/);
    const closed = render('askConfirm', CONFIRM, { answerable: false });
    assert.equal(closed.match(/<button[^>]*disabled/g)?.length, 2);
  });

  it('agent text is rendered as text, never markup', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = render('askChoice', { question: hostile, options: [{ id: 'a', label: hostile }, { id: 'b', label: '<script>x</script>' }] });
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img src=x onerror=/);
  });

  it('multiSelect (WID-MS): one checkbox card with a counter, and the answered state lists every chosen label', () => {
    const multi = { ...CHOICE, recommended: undefined, multiSelect: true, maxSelected: 1 };
    const pending = render('askChoice', multi);
    assert.match(pending, /data-card="choice"/);
    assert.equal(pending.match(/type="checkbox"/g)?.length, 2); // one card of checkboxes — not one toggle per option
    assert.doesNotMatch(pending, /type="radio"/);
    assert.match(pending, /0 of 1 selected/); // counter names the cap while nothing is picked
    const answered = render('askChoice', multi, { answer: { choices: ['basic', 'pro'] } });
    assert.match(answered, /data-card-status="answered"/);
    assert.match(answered, /Chosen: Basic, Pro/);
  });

  it('form multiSelect (WID-MS): a field renders as one checkbox group; the answered card lists every chosen label', () => {
    const props = { title: 'Scope', fields: [{ name: 'tags', label: 'Tags', type: 'multiSelect', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }] };
    const pending = render('askForm', props);
    assert.match(pending, /data-field="tags" data-field-type="multiSelect"/);
    assert.match(pending, /<fieldset/);
    assert.equal(pending.match(/name="tags\.(x|y)"/g)?.length, 2);
    const answered = render('askForm', props, { answer: { values: { tags: ['x', 'y'] } } });
    assert.match(answered, /<dd[^>]*>X, Y<\/dd>/);
  });

  it('the client check matches the server: an answer outside the card is refused before it is sent', () => {
    const accepted: unknown[] = [];
    const invalid: string[][] = [];
    let onAnswer: ((a: unknown) => void) | undefined;
    const Probe = registry.latest('askChoice')!;
    const capture: typeof Probe = { ...Probe, component: (p: any) => ((onAnswer = p.onAnswer), null) };
    renderToStaticMarkup(
      React.createElement(WidgetToolCall, {
        registry: createWidgetRegistry([capture, { ...capture, version: 1 }]), // WID-MS: askChoice registers v1 + v2; register both so a widgetVersion-omitting call (default v1) resolves
        toolCall: { toolCallId: 'c1', toolName: 'askChoice', args: CHOICE },
        onAnswer: (r) => accepted.push(r),
        onInvalidAnswer: (i) => invalid.push(i),
      }),
    );
    onAnswer!({ choice: 'gold' });
    onAnswer!({ choice: 'basic' });
    onAnswer!({ choice: 'pro' }); // only the first accepted answer per attempt
    assert.deepEqual(invalid, [['choice: not_an_option']]);
    assert.equal(accepted.length, 1);
    assert.equal((accepted[0] as { toolResult: string }).toolResult, JSON.stringify({ widget: 'askChoice', version: 1, answer: { choice: 'basic' } }));
  });
});
