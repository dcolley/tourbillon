/**
 * OBS-2: reaction controls under assistant messages (stateless view + chat placement) and the
 * thread feedback hook's requests. Markup via react-dom/server; controls found by walking the tree.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatState } from '../../lib/agui/client/chat-state';
import type { MessageFeedbackViewProps } from './message-feedback';

type FeedbackModule = typeof import('./message-feedback');
let MessageFeedbackView: FeedbackModule['MessageFeedbackView'];
let threadFeedbackUrl: FeedbackModule['threadFeedbackUrl'];
let AgentChatView: typeof import('./agent-chat').AgentChatView;
let Button: unknown;

const noop = () => {};
function viewProps(extra: Partial<MessageFeedbackViewProps> = {}): MessageFeedbackViewProps {
  return {
    saved: null,
    reasonOpen: false,
    reason: '',
    tags: [],
    saving: false,
    error: null,
    onRate: noop,
    onToggleTag: noop,
    onReasonChange: noop,
    onSubmitReason: noop,
    onCloseReason: noop,
    ...extra,
  };
}

type Found = { props: Record<string, any> };
function find(node: React.ReactNode, pred: (type: unknown, props: Record<string, any>) => boolean): Found[] {
  const out: Found[] = [];
  const walk = (n: React.ReactNode): void => {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (!React.isValidElement(n)) return;
    const p = n.props as Record<string, any>;
    if (pred(n.type, p)) out.push({ props: p });
    if (n.type === Button) return;
    if (typeof n.type === 'function') return walk((n.type as (p: unknown) => React.ReactNode)(p));
    walk(p.children);
  };
  walk(node);
  return out;
}
const buttons = (node: React.ReactNode) => find(node, (t) => t === Button);
const thumbs = (node: React.ReactNode) =>
  buttons(node).filter((b) => b.props['aria-label'] === 'Good response' || b.props['aria-label'] === 'Bad response');

describe('OBS-2 message feedback', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ MessageFeedbackView, threadFeedbackUrl } = await import('./message-feedback'));
    ({ AgentChatView } = await import('./agent-chat'));
    ({ Button } = await import('@/components/ui/button'));
  });

  it('shows thumbs up / down, neither pressed, and no reason form by default', () => {
    const t = thumbs(MessageFeedbackView(viewProps()));
    assert.deepEqual(t.map((b) => [b.props['aria-label'], b.props['aria-pressed']]), [
      ['Good response', false],
      ['Bad response', false],
    ]);
    const html = renderToStaticMarkup(React.createElement(MessageFeedbackView, viewProps()));
    assert.doesNotMatch(html, /data-feedback-reason/);
  });

  it('a saved reaction shows as pressed (e.g. after reload)', () => {
    const saved = { rating: 'down' as const, reason: null, tags: [], updatedAt: 't' };
    const t = thumbs(MessageFeedbackView(viewProps({ saved })));
    assert.deepEqual(t.map((b) => b.props['aria-pressed']), [false, true]);
    assert.match(renderToStaticMarkup(React.createElement(MessageFeedbackView, viewProps({ saved }))), /data-message-feedback="down"/);
  });

  it('thumbs call onRate; buttons are disabled while saving', () => {
    const rated: string[] = [];
    const t = thumbs(MessageFeedbackView(viewProps({ onRate: (r) => rated.push(r) })));
    t[0].props.onClick();
    t[1].props.onClick();
    assert.deepEqual(rated, ['up', 'down']);
    assert.deepEqual(thumbs(MessageFeedbackView(viewProps({ saving: true }))).map((b) => b.props.disabled), [true, true]);
  });

  it('reason form after thumbs down: preset tags toggle, note, Send and Skip', () => {
    const calls: string[] = [];
    const p = viewProps({
      reasonOpen: true,
      tags: ['incorrect'],
      reason: 'wrong year',
      onToggleTag: (t) => calls.push(`tag:${t}`),
      onReasonChange: (v) => calls.push(`reason:${v}`),
      onSubmitReason: () => calls.push('send'),
      onCloseReason: () => calls.push('skip'),
    });
    const html = renderToStaticMarkup(React.createElement(MessageFeedbackView, p));
    assert.match(html, /data-feedback-reason/);
    assert.match(html, /wrong year/);
    for (const label of ['Incorrect', 'Not helpful', 'Incomplete', 'Off topic', 'Unsafe']) assert.match(html, new RegExp(label));

    const tree = MessageFeedbackView(p);
    const tags = buttons(tree).filter((b) => b.props['data-feedback-tag']);
    assert.deepEqual(tags.map((b) => [b.props['data-feedback-tag'], b.props['aria-pressed']]).slice(0, 2), [
      ['incorrect', true],
      ['unhelpful', false],
    ]);
    tags[1].props.onClick();
    const [textarea] = find(tree, (t) => t === 'textarea');
    textarea.props.onChange({ target: { value: 'x' } });
    const [form] = find(tree, (t) => t === 'form');
    form.props.onSubmit({ preventDefault: noop });
    buttons(tree).find((b) => b.props.children === 'Skip')!.props.onClick();
    assert.deepEqual(calls, ['tag:unhelpful', 'reason:x', 'send', 'skip']);
  });

  it('chat: one footer per finished assistant message (last segment), none while it streams', () => {
    const footers: string[] = [];
    const state: AgentChatState = {
      ...initialAgentChatState,
      status: 'running',
      items: [
        { kind: 'user', id: 'u1', text: 'q', mode: 'run', delivery: 'delivered' },
        { kind: 'assistant', id: 'm1', text: 'part 1', streaming: false },
        { kind: 'assistant', id: 'm1:text:1', text: 'part 2', streaming: false },
        { kind: 'user', id: 'u2', text: 'q2', mode: 'run', delivery: 'delivered' },
        { kind: 'assistant', id: 'm2', text: 'typing', streaming: true },
      ],
    };
    const props = {
      phase: 'ready' as const,
      setupError: null,
      state,
      draft: '',
      onDraftChange: noop,
      onSend: noop,
      onSteer: noop,
      onStop: noop,
      onToolDecision: noop,
      onDismissError: noop,
      assistantFooter: (messageId: string) => {
        footers.push(messageId);
        return React.createElement('span', { 'data-footer': messageId });
      },
    };
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props));
    assert.deepEqual(footers, ['m1']);
    assert.ok(html.indexOf('part 2') < html.indexOf('data-footer="m1"'), 'footer follows the last segment');

    footers.length = 0;
    const idle = { ...state, status: 'idle' as const, items: state.items.map((i) => (i.id === 'm2' ? { ...i, streaming: false } : i)) };
    renderToStaticMarkup(React.createElement(AgentChatView, { ...props, state: idle }));
    assert.deepEqual(footers, ['m1', 'm2']);

    footers.length = 0;
    const { assistantFooter: _omit, ...withoutFooter } = props;
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(AgentChatView, { ...withoutFooter, state: idle })), /data-footer/);
  });

  it('feedback URL is the assistant thread route, with ids encoded', () => {
    assert.equal(threadFeedbackUrl('agent-a', 't1'), '/api/assistant/agents/agent-a/threads/t1/feedback');
    assert.equal(threadFeedbackUrl('a/b', 't 1'), '/api/assistant/agents/a%2Fb/threads/t%201/feedback');
  });
});
