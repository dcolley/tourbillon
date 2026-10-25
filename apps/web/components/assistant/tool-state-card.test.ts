/** CHAT-2: tool-state card variants for plain tool calls. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCallStatus } from '../../lib/agui/client/chat-state';

type T = typeof import('./tool-state-card');
let mod: T;
const render = (props: Partial<Parameters<T['ToolStateCard']>[0]> & { status: ToolCallStatus }) =>
  renderToStaticMarkup(React.createElement(mod.ToolStateCard, { toolCallId: 'call-1', toolName: 'searchIssues', ...props }));

describe('CHAT-2 ToolStateCard', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./tool-state-card');
  });

  it('every tool status has a variant and label', () => {
    const cases: Array<[ToolCallStatus, string, string]> = [
      ['streaming_args', 'running', 'Preparing'],
      ['running', 'running', 'Running'],
      ['awaiting_approval', 'waiting', 'Waiting for approval'],
      ['suspended', 'waiting', 'Waiting for input'],
      ['done', 'done', 'Done'],
      ['error', 'error', 'Error'],
      ['denied', 'declined', 'Declined'],
      ['detached', 'detached', 'Result not shown'],
    ];
    for (const [status, variant, label] of cases) {
      const h = render({ status });
      assert.match(h, new RegExp(`data-tool-card="true" data-tool-state="${variant}" data-tool-call-id="call-1"`), status);
      assert.match(h, new RegExp(`data-status="${status}"[^>]*>${label}`), status);
      assert.match(h, /searchIssues/);
    }
    assert.match(render({ status: 'denied' }), /declined and did not run/);
    assert.match(render({ status: 'detached' }), /result is not shown in this chat/);
  });

  it('running with streamed partial args: no arguments section yet', () => {
    const h = render({ status: 'streaming_args', argsText: '{"query":"op' });
    assert.doesNotMatch(h, /data-tool-section/);
    assert.match(h, /Preparing…/);
  });

  it('done: arguments and result, JSON pretty-printed with sensitive keys masked', () => {
    const h = render({
      status: 'done',
      argsText: JSON.stringify({ query: 'open', apiKey: 'sk-live-123' }),
      result: JSON.stringify({ count: 2, token: 'abc', items: [{ id: 'i1', password: 'p' }] }),
    });
    assert.match(h, /data-tool-section="arguments"/);
    assert.match(h, /data-tool-section="result"/);
    assert.match(h, /&quot;count&quot;: 2/);
    assert.match(h, /&quot;token&quot;: &quot;\[redacted\]&quot;/);
    assert.match(h, /&quot;password&quot;: &quot;\[redacted\]&quot;/);
    assert.match(h, /&quot;apiKey&quot;: &quot;\[redacted\]&quot;/);
    assert.doesNotMatch(h, /sk-live-123|"abc"|&quot;abc&quot;/);
  });

  it('error: the error text is shown open, as text', () => {
    const h = render({ status: 'error', result: 'Tool failed: <img src=x onerror=alert(1)>' });
    assert.match(h, /<details data-tool-section="error" open="">/);
    assert.match(h, />Error<\/summary>/);
    assert.match(h, /Tool failed: &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(h, /<img/i);
  });

  it('resultPreview: plain text kept, JSON strings unwrapped, long results capped', () => {
    assert.equal(mod.resultPreview(undefined), null);
    assert.equal(mod.resultPreview(''), null);
    assert.equal(mod.resultPreview('plain words'), 'plain words');
    assert.equal(mod.resultPreview('"quoted"'), 'quoted');
    assert.equal(mod.resultPreview('x'.repeat(mod.TOOL_RESULT_MAX_CHARS + 1)), mod.RESULT_TOO_LARGE);
    const long = mod.resultPreview('y'.repeat(5000));
    assert.ok(long && long.endsWith('… (truncated)') && long.length < 5000);
  });
});
