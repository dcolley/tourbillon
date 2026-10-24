/**
 * WID-3: chat cards in the assistant chat view — a card the run waits on renders in place (no generic
 * Continue / Decline row), hands its answer / dismissal to the chat with the tool call id, and renders
 * locked once the tool result says it was answered or dismissed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatItem, type AgentChatState } from '../../lib/agui/client/chat-state';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];
let widgetOutcome: View['widgetOutcome'];
let WidgetToolCall: unknown;

const noop = () => {};
const CALL = 'card-1';
const ARGS = JSON.stringify({ question: 'Which plan?', options: [{ id: 'a', label: 'Plan A' }, { id: 'b', label: 'Plan B' }] });

function toolItem(extra: Partial<Extract<AgentChatItem, { kind: 'tool' }>> = {}): AgentChatItem {
  return { kind: 'tool', id: CALL, name: 'askChoice', argsText: ARGS, status: 'suspended', ...extra };
}

function props(state: Partial<AgentChatState>, extra: Record<string, unknown> = {}) {
  return {
    phase: 'ready' as const,
    setupError: null,
    state: { ...initialAgentChatState, ...state },
    draft: '',
    onDraftChange: noop,
    onSend: noop,
    onSteer: noop,
    onStop: noop,
    onToolDecision: noop,
    onDismissError: noop,
    ...extra,
  };
}

const suspended = {
  items: [toolItem()],
  pendingTools: [{ toolCallId: CALL, toolName: 'askChoice', reason: 'tool_suspended' as const, args: null }],
};

/** The WidgetToolCall element in the view's tree (function components expanded). */
function widgetElement(node: React.ReactNode): Record<string, any> | undefined {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = widgetElement(n);
      if (found) return found;
    }
    return undefined;
  }
  if (!React.isValidElement(node)) return undefined;
  const p = node.props as Record<string, any>;
  if (node.type === WidgetToolCall) return p;
  if (typeof node.type === 'function' && /^[A-Z]/.test(node.type.name) && node.type.name !== 'Button') {
    try {
      return widgetElement((node.type as (p: unknown) => React.ReactNode)(p));
    } catch {
      return widgetElement(p.children);
    }
  }
  return widgetElement(p.children);
}

describe('WID-3 chat cards in the assistant chat view', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView, widgetOutcome } = await import('./agent-chat'));
    ({ WidgetToolCall } = await import('./widgets/widget-tool-call'));
  });

  it('a card the run waits on renders in place, without the generic Continue / Decline row', () => {
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props(suspended, { onWidgetAnswer: noop })));
    assert.match(html, /data-card="choice"/);
    assert.match(html, /data-card-status="pending"/);
    assert.match(html, /Plan A/);
    assert.doesNotMatch(html, /data-pending-tool=/);
    assert.doesNotMatch(html, /data-widget="fallback"/);
  });

  it('other suspended tools still get the Continue row', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        props({
          items: [toolItem({ name: 'web_search', argsText: '{"q":"x"}' })],
          pendingTools: [{ toolCallId: CALL, toolName: 'web_search', reason: 'tool_suspended', args: null }],
        }),
      ),
    );
    assert.match(html, /data-pending-tool="card-1"/);
    assert.match(html, /data-widget="fallback"/);
  });

  it('the card hands its answer and its dismissal to the chat with the tool call id', () => {
    const answers: unknown[][] = [];
    const dismissed: string[] = [];
    const view = AgentChatView(
      props(suspended, { onWidgetAnswer: (...a: unknown[]) => answers.push(a), onWidgetDismiss: (id: string) => dismissed.push(id) }),
    );
    const w = widgetElement(view)!;
    assert.equal(w.answerable, true);
    assert.equal(w.busy, false);
    w.onAnswer({ toolResult: '{}', record: { toolCallId: CALL, answer: { choice: 'b' } } });
    w.onDismiss();
    assert.deepEqual(answers, [[CALL, { choice: 'b' }]]);
    assert.deepEqual(dismissed, [CALL]);
  });

  it('read-only without handlers, and not answerable unless the run waits on it', () => {
    assert.equal(widgetElement(AgentChatView(props(suspended)))!.answerable, false);
    const running = props({ items: [toolItem({ status: 'running' })] }, { onWidgetAnswer: noop });
    assert.equal(widgetElement(AgentChatView(running))!.answerable, false);
  });

  it('while the answer is sending the card is busy; a refused send counts an attempt so it can be answered again', () => {
    const sending = props({ ...suspended, items: [toolItem({ widgetSend: { phase: 'sending', attempts: 0 } })] }, { onWidgetAnswer: noop });
    assert.equal(widgetElement(AgentChatView(sending))!.busy, true);
    assert.match(renderToStaticMarkup(React.createElement(AgentChatView, sending)), /Sending…/);
    const failed = props({ ...suspended, items: [toolItem({ widgetSend: { phase: 'failed', attempts: 2 } })] }, { onWidgetAnswer: noop });
    const w = widgetElement(AgentChatView(failed))!;
    assert.equal(w.busy, false);
    assert.equal(w.attempt, 2);
  });

  it('answered and dismissed cards render locked from the tool result', () => {
    const answered = toolItem({ status: 'done', result: JSON.stringify({ widget: 'askChoice', version: 1, answer: { choice: 'b' } }) });
    assert.deepEqual(widgetOutcome(answered as never), { answer: { choice: 'b' }, dismissed: false });
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [answered] }, { onWidgetAnswer: noop })));
    assert.match(html, /data-card-status="answered"/);
    assert.match(html, /Chosen: Plan B/);
    assert.doesNotMatch(html, />Choose</);

    const dismissedItem = toolItem({ status: 'done', result: JSON.stringify({ widget: 'askChoice', version: 1, dismissed: true }) });
    assert.deepEqual(widgetOutcome(dismissedItem as never), { dismissed: true });
    const d = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [dismissedItem] })));
    assert.match(d, /data-card-status="dismissed"/);
    assert.match(d, /Dismissed without an answer\./);

    // A result for another widget name, or an error result, is not taken as this card's outcome.
    assert.deepEqual(widgetOutcome(toolItem({ status: 'done', result: JSON.stringify({ widget: 'askForm', version: 1, dismissed: true }) }) as never), { dismissed: false });
    assert.deepEqual(widgetOutcome(toolItem({ status: 'error', result: 'boom' }) as never), { dismissed: false });
  });
});
