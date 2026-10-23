/**
 * WID-1: widget registry — lookup by name + version, schema failures, fallback reasons and warnings,
 * frontend tool declarations, answer validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createWidgetRegistry, assistantWidgetRegistry, WidgetRegistryError } from './registry';
import type { WidgetDefinition } from './widget-types';

const Noop = () => null;

const pickV1: WidgetDefinition = {
  name: 'pickOne',
  version: 1,
  description: 'Ask the user to pick one option.',
  propsSchema: z.object({ question: z.string().min(1), options: z.array(z.string()).min(2) }),
  answerSchema: z.object({ choice: z.string() }),
  component: Noop,
  frontendTool: true,
};
const pickV2: WidgetDefinition = {
  ...pickV1,
  version: 2,
  propsSchema: z.object({ question: z.string().min(1), options: z.array(z.string()).min(2), multiple: z.boolean().default(false) }),
  answerSchema: z.object({ choices: z.array(z.string()).min(1) }),
};
const status: WidgetDefinition = {
  name: 'statusNote',
  version: 1,
  description: 'Display-only note.',
  propsSchema: z.object({ text: z.string() }),
  component: Noop,
};

function registry() {
  const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
  const reg = createWidgetRegistry([pickV2, status, pickV1], { warn: (message, details) => warnings.push({ message, details }) });
  return { reg, warnings };
}

const call = (toolName: string, args: unknown, toolCallId = 'call-1') => ({ toolCallId, toolName, args });

describe('WID-1 registry lookup', () => {
  it('get / latest / list', () => {
    const { reg } = registry();
    assert.equal(reg.get('pickOne', 1), pickV1);
    assert.equal(reg.get('pickOne', 2), pickV2);
    assert.equal(reg.get('pickOne', 3), undefined);
    assert.equal(reg.latest('pickOne'), pickV2);
    assert.equal(reg.latest('nope'), undefined);
    assert.deepEqual(reg.list().map((d) => `${d.name}@${d.version}`), ['pickOne@1', 'pickOne@2', 'statusNote@1']);
  });

  it('refuses duplicate name+version, bad names and bad versions at registration', () => {
    assert.throws(() => createWidgetRegistry([pickV1, { ...pickV1 }]), WidgetRegistryError);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, name: 'Pick-One' }]), /Invalid widget name/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, version: 0 }]), /Invalid version/);
    assert.throws(() => createWidgetRegistry([{ ...pickV1, version: 1.5 }]), /Invalid version/);
  });

  it('the assistant registry starts empty, so every tool call falls back', () => {
    assert.deepEqual(assistantWidgetRegistry.list(), []);
    assert.deepEqual(assistantWidgetRegistry.frontendTools(), []);
  });
});

describe('WID-1 registry resolve', () => {
  it('resolves by version (default 1) and returns schema-parsed props', () => {
    const { reg, warnings } = registry();
    const v1 = reg.resolve(call('pickOne', { question: 'Which?', options: ['a', 'b'] }));
    assert.ok(v1.ok);
    assert.equal(v1.definition, pickV1);
    const v2 = reg.resolve(call('pickOne', JSON.stringify({ question: 'Which?', options: ['a', 'b'], widgetVersion: 2 })));
    assert.ok(v2.ok);
    assert.equal(v2.definition, pickV2);
    assert.deepEqual(v2.call.props, { question: 'Which?', options: ['a', 'b'], multiple: false });
    assert.deepEqual(warnings, []);
  });

  it('unknown widget, unknown version, invalid props and bad calls give a reason and one warning each', () => {
    const { reg, warnings } = registry();
    const cases: Array<[unknown, string]> = [
      [call('noSuchWidget', {}), 'unknown_widget'],
      [call('pickOne', { question: 'q', options: ['a', 'b'], widgetVersion: 9 }), 'unknown_version'],
      [call('pickOne', { question: '', options: ['a'] }), 'invalid_props'],
      [call('pickOne', '{not json'), 'invalid_args'],
      [call('web_search', {}), 'invalid_name'],
      [{ toolName: 'pickOne' }, 'invalid_call'],
    ];
    for (const [input, reason] of cases) {
      const r = reg.resolve(input);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, reason);
    }
    assert.equal(warnings.length, cases.length);
    assert.deepEqual(warnings.map((w) => w.details.reason), cases.map(([, reason]) => reason));
  });

  it('invalid-props warnings name the failing paths but never log prop values', () => {
    const { reg, warnings } = registry();
    reg.resolve(call('pickOne', { question: 42, options: ['secret-value-xyz'] }, 'call-9'));
    assert.equal(warnings.length, 1);
    const { details } = warnings[0];
    assert.equal(details.toolCallId, 'call-9');
    assert.equal(details.toolName, 'pickOne');
    assert.deepEqual(details.issues, ['question: invalid_type', 'options: too_small']);
    assert.doesNotMatch(JSON.stringify(warnings), /secret-value-xyz/);
  });
});

describe('WID-1 frontend tools', () => {
  it('declares the latest version of each frontend-tool widget with JSON Schema parameters', () => {
    const { reg } = registry();
    const tools = reg.frontendTools();
    assert.deepEqual(tools.map((t) => t.name), ['pickOne']);
    const [tool] = tools;
    assert.equal(tool.description, pickV1.description);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.$schema, undefined);
    const props = tool.parameters.properties as Record<string, any>;
    assert.deepEqual(Object.keys(props).sort(), ['multiple', 'options', 'question', 'widgetVersion']);
    assert.deepEqual(props.widgetVersion, { type: 'integer', const: 2 });
    assert.deepEqual(tool.parameters.required, ['question', 'options']);
  });
});

describe('WID-1 answers', () => {
  it('valid answers become a stored record and a tool result; invalid ones list issues', () => {
    const { reg } = registry();
    const r = reg.resolve(call('pickOne', { question: 'q', options: ['a', 'b'] }, 'call-7'));
    assert.ok(r.ok);
    const ok = reg.acceptAnswer(r, { choice: 'b' }, new Date('2026-10-23T15:00:00.000Z'));
    assert.deepEqual(ok, {
      ok: true,
      record: { toolCallId: 'call-7', widget: 'pickOne', version: 1, answer: { choice: 'b' }, answeredAt: '2026-10-23T15:00:00.000Z' },
      toolResult: JSON.stringify({ widget: 'pickOne', version: 1, answer: { choice: 'b' } }),
    });
    assert.deepEqual(reg.acceptAnswer(r, { choice: 3 }), { ok: false, issues: ['choice: invalid_type'] });
  });

  it('display-only widgets take no answers', () => {
    const { reg } = registry();
    const r = reg.resolve(call('statusNote', { text: 'hi' }));
    assert.ok(r.ok);
    assert.equal(reg.acceptAnswer(r, 'x').ok, false);
  });
});
