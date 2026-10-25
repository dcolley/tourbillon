/**
 * WID-3: chat cards in the assistant chat view — a card the run waits on renders in place (no generic
 * Continue / Decline row), hands its answer / dismissal to the chat with the tool call id, and renders
 * locked once the tool result says it was answered or dismissed. While the run is parked on a card, a
 * notice names it and offers Dismiss card / Stop (or a link when the card is in another chat).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatItem, type AgentChatState } from '../../lib/agui/client/chat-state';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];
let widgetOutcome: View['widgetOutcome'];
let pendingCardDescription: View['pendingCardDescription'];
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
    ({ AgentChatView, widgetOutcome, pendingCardDescription } = await import('./agent-chat'));
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
    // CHAT-2: a tool with no widget renders the tool state card (not the WID-1 fallback card).
    assert.match(html, /data-tool-card="true"[^>]*data-tool-state="waiting"/);
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

  it('a parked card is named in a notice with Dismiss card and Stop, and the status says it waits for an answer', () => {
    const stops: number[] = [];
    const dismissed: string[] = [];
    const p = props(suspended, { onWidgetAnswer: noop, onWidgetDismiss: (id: string) => dismissed.push(id), onStop: () => stops.push(1) });
    const html = renderToStaticMarkup(React.createElement(AgentChatView, p));
    assert.match(html, /data-parked-widget="card-1"/);
    assert.match(html, /The choice card \(“Which plan\?”\) is waiting for your answer/);
    assert.match(html, />Dismiss card</);
    assert.match(html, />Stop</);
    assert.match(html, /data-parked="true"[^>]*>Waiting for your answer</);
    assert.match(html, /data-status="idle"/);

    // The notice's buttons call dismiss (with the call id) and stop.
    const notice = findByProp(AgentChatView(p), 'data-parked-widget')!;
    const buttons = collect(notice, (n) => typeof n.props.onClick === 'function');
    buttons.forEach((b) => b.props.onClick());
    assert.deepEqual(dismissed, [CALL]);
    assert.equal(stops.length, 1);
  });

  it('no notice when nothing is parked, or while a run is open', () => {
    const idle = renderToStaticMarkup(React.createElement(AgentChatView, props({})));
    assert.doesNotMatch(idle, /data-parked-widget/);
    assert.match(idle, />Idle</);
    const running = renderToStaticMarkup(React.createElement(AgentChatView, props({ ...suspended, status: 'running' })));
    assert.doesNotMatch(running, /data-parked-widget/);
  });

  it('a card parked in another chat (e.g. before Clear chat) is named, has no Dismiss here, and offers Stop to continue', () => {
    const parked = { threadId: 'thread-0', toolCallId: 'card-0', toolName: 'askForm', label: 'Setup', elsewhere: true };
    const html = renderToStaticMarkup(
      React.createElement(AgentChatView, props({ parked }, { onWidgetDismiss: noop, chatHref: (t: string) => `/assistant/alice/${t}` })),
    );
    assert.match(html, /data-parked-elsewhere="true"/);
    // ASYNC-0 Slice B: not a silent strand; it says where the card is and how to continue here.
    assert.match(html, /A form card from an earlier conversation \(“Setup”\) is still waiting for an answer\. Stop it to continue here\./);
    assert.match(html, /href="\/assistant\/alice\/thread-0"/);
    assert.doesNotMatch(html, />Dismiss card</);
    assert.match(html, />Stop it and continue here</);
    // Without a link (the assistant view has none for earlier threads), Stop is still offered.
    const noLink = renderToStaticMarkup(React.createElement(AgentChatView, props({ parked }, { onWidgetDismiss: noop })));
    assert.doesNotMatch(noLink, /Open that chat/);
    assert.match(noLink, /data-parked-stop[^>]*>Stop it and continue here</);
  });

  it('pendingCardDescription names the waiting card for the Clear chat confirm', () => {
    assert.equal(pendingCardDescription(null), null);
    assert.equal(
      pendingCardDescription({ threadId: 't', toolCallId: 'c', toolName: 'askForm', label: 'Setup', elsewhere: false }),
      'form card (“Setup”)',
    );
    assert.equal(pendingCardDescription({ threadId: 't', toolCallId: 'c', toolName: 'unknownTool', elsewhere: false }), 'widget card');
  });

  it('a card whose parked run was stopped renders locked with a note', () => {
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [toolItem({ status: 'stopped' })] }, { onWidgetAnswer: noop })));
    assert.match(html, /Run stopped — this card no longer takes an answer\./);
    assert.equal(widgetElement(AgentChatView(props({ items: [toolItem({ status: 'stopped' })] }, { onWidgetAnswer: noop })))!.answerable, false);
    assert.doesNotMatch(html, /data-parked-widget/);
  });
});

/** Expands function components (not Button) and returns matching elements. */
function collect(node: React.ReactNode, match: (n: React.ReactElement<any>) => boolean, out: React.ReactElement<any>[] = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, match, out));
    return out;
  }
  if (!React.isValidElement(node)) return out;
  const el = node as React.ReactElement<any>;
  if (match(el)) out.push(el);
  if (typeof el.type === 'function' && /^[A-Z]/.test(el.type.name) && el.type.name !== 'Button') {
    try {
      collect((el.type as (p: unknown) => React.ReactNode)(el.props), match, out);
      return out;
    } catch {
      /* hooks: fall through to children */
    }
  }
  if (match(el) && el.type !== 'div') return out;
  collect(el.props?.children, match, out);
  return out;
}

const findByProp = (node: React.ReactNode, prop: string) => collect(node, (n) => typeof n.type === 'string' && n.props?.[prop] !== undefined)[0];
