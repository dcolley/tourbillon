/**
 * WID-1: rendering — a registered test widget renders from a stub tool call and hands back a
 * validated answer; anything that does not resolve shows the fallback card (never blank).
 * The repo has no DOM test library, so this uses react-dom/server markup.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import type { WidgetComponentProps, WidgetDefinition } from './widget-types';

type Mod = typeof import('./widget-tool-call');
type Reg = typeof import('./registry');
type Fallback = typeof import('./fallback-card');

let WidgetToolCall: Mod['WidgetToolCall'];
let createWidgetRegistry: Reg['createWidgetRegistry'];
let FallbackToolCard: Fallback['FallbackToolCard'];

/** Captured from the last render of the test widget. */
let lastOnAnswer: ((a: unknown) => void) | undefined;

function TestPicker({ props, status, answer, onAnswer }: WidgetComponentProps<{ question: string; options: string[] }, { choice: string }>) {
  lastOnAnswer = onAnswer as never;
  return React.createElement(
    'fieldset',
    { 'data-test-widget': '', disabled: status === 'answered' },
    React.createElement('legend', null, props.question),
    ...props.options.map((o) => React.createElement('label', { key: o }, o)),
    answer ? React.createElement('output', null, `Chosen: ${answer.choice}`) : null,
  );
}

const picker: WidgetDefinition = {
  name: 'testPicker',
  version: 1,
  description: 'Test widget.',
  propsSchema: z.object({ question: z.string().min(1), options: z.array(z.string()).min(2) }),
  answerSchema: z.object({ choice: z.string() }),
  component: TestPicker,
  frontendTool: true,
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('WID-1 WidgetToolCall', () => {
  const warnings: unknown[] = [];
  let registry: ReturnType<Reg['createWidgetRegistry']>;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ WidgetToolCall } = await import('./widget-tool-call'));
    ({ createWidgetRegistry } = await import('./registry'));
    ({ FallbackToolCard } = await import('./fallback-card'));
    registry = createWidgetRegistry([picker], { warn: (_m, d) => warnings.push(d) });
  });

  const stubCall = (args: unknown, toolName = 'testPicker') => ({ toolCallId: 'call-1', toolName, args });

  it('renders the registered widget from a stub tool call (JSON-string args, as streamed)', () => {
    const html = render(
      React.createElement(WidgetToolCall, {
        registry,
        toolCall: stubCall(JSON.stringify({ question: 'Ship today?', options: ['Yes', 'No'] })),
      }),
    );
    assert.match(html, /data-widget="testPicker"/);
    assert.match(html, /data-widget-version="1"/);
    assert.match(html, /<legend>Ship today\?<\/legend>/);
    assert.doesNotMatch(html, /data-widget="fallback"/);
  });

  it('a valid answer produces the tool result for the run; an invalid one is refused', () => {
    const results: Array<{ toolResult: string; record: any }> = [];
    const invalid: string[][] = [];
    render(
      React.createElement(WidgetToolCall, {
        registry,
        toolCall: stubCall({ question: 'Ship today?', options: ['Yes', 'No'] }),
        onAnswer: (r) => results.push(r as never),
        onInvalidAnswer: (i) => invalid.push(i),
      }),
    );
    assert.ok(lastOnAnswer);
    lastOnAnswer!({ choice: 7 });
    lastOnAnswer!({ choice: 'Yes' });
    assert.deepEqual(invalid, [['choice: invalid_type']]);
    assert.equal(results.length, 1);
    assert.equal(results[0].toolResult, JSON.stringify({ widget: 'testPicker', version: 1, answer: { choice: 'Yes' } }));
    assert.equal(results[0].record.toolCallId, 'call-1');
  });

  it('an answered widget renders locked with its answer and takes no further answers', () => {
    const html = render(
      React.createElement(WidgetToolCall, {
        registry,
        toolCall: stubCall({ question: 'Ship today?', options: ['Yes', 'No'] }),
        answer: { choice: 'No' },
      }),
    );
    assert.match(html, /<fieldset[^>]*disabled/);
    assert.match(html, /Chosen: No/);
    assert.equal(lastOnAnswer, undefined);
  });

  it('invalid props show the fallback card with the reason and log a warning', () => {
    warnings.length = 0;
    const html = render(
      React.createElement(WidgetToolCall, { registry, toolCall: stubCall({ question: '', options: ['only'] }), toolStatus: 'done' }),
    );
    assert.match(html, /data-widget="fallback"/);
    assert.match(html, /data-reason="invalid_props"/);
    assert.match(html, /The card data was not valid\./);
    assert.match(html, /data-status="done"/);
    assert.equal(warnings.length, 1);
  });

  it('unknown widgets and unknown versions also fall back, never blank', () => {
    for (const [toolCall, reason] of [
      [stubCall({ x: 1 }, 'somethingElse'), 'unknown_widget'],
      [stubCall({ question: 'q', options: ['a', 'b'], widgetVersion: 4 }), 'unknown_version'],
      [stubCall('{oops'), 'invalid_args'],
    ] as const) {
      const html = render(React.createElement(WidgetToolCall, { registry, toolCall }));
      assert.match(html, new RegExp(`data-reason="${reason}"`));
      assert.ok(html.length > 0);
    }
  });
});

describe('WID-1 FallbackToolCard', () => {
  it('shows tool name, status and masked arguments', () => {
    const html = renderToStaticMarkup(
      React.createElement(FallbackToolCard, {
        toolName: 'web_search',
        toolCallId: 'c1',
        status: 'running',
        args: JSON.stringify({ query: 'weather', apiKey: 'sk-not-shown' }),
      }),
    );
    assert.match(html, /web_search/);
    assert.match(html, /Running/);
    assert.match(html, /data-reason="none"/);
    assert.match(html, /weather/);
    assert.match(html, /\[redacted\]/);
    assert.doesNotMatch(html, /sk-not-shown/);
  });

  it('handles missing name, no args and unreadable args', () => {
    const bare = renderToStaticMarkup(React.createElement(FallbackToolCard, {}));
    assert.match(bare, /Tool call/);
    assert.doesNotMatch(bare, /Arguments/);
    const bad = renderToStaticMarkup(React.createElement(FallbackToolCard, { toolName: 't', args: '{x', status: 'failed' }));
    assert.match(bad, /arguments could not be read/);
    assert.match(bad, /Failed/);
  });
});
