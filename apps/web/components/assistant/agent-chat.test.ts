/**
 * AGUI-1b: assistant chat view (stateless part) and the /assistant page's agent selection.
 * No DOM test library in the repo: markup via react-dom/server, and controls found by walking the
 * element tree (plain function components are expanded; Button and WidgetToolCall are leaves).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  initialAgentChatState,
  RUN_CANCELLED_MESSAGE,
  TOOL_DETACHED_MESSAGE,
  type AgentChatState,
} from '../../lib/agui/client/chat-state';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];
let AgentChat: View['AgentChat'];
let agentChatHref: View['agentChatHref'];
let Button: unknown;
let WidgetToolCall: unknown;
let AssistantPage: (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<React.ReactElement>;
let AssistantEmptyState: unknown;

const noop = () => {};
function props(state: Partial<AgentChatState>, extra: Partial<Parameters<View['AgentChatView']>[0]> = {}) {
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

/** Buttons in the rendered tree: label + props. */
function buttons(node: React.ReactNode): Array<{ label: string; disabled: boolean; onClick?: () => void; type?: string }> {
  const out: Array<{ label: string; disabled: boolean; onClick?: () => void; type?: string }> = [];
  const text = (n: React.ReactNode): string =>
    n == null || typeof n === 'boolean'
      ? ''
      : typeof n === 'string' || typeof n === 'number'
        ? String(n)
        : Array.isArray(n)
          ? n.map(text).join('')
          : React.isValidElement(n)
            ? text((n.props as { children?: React.ReactNode }).children)
            : '';
  const walk = (n: React.ReactNode): void => {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (!React.isValidElement(n)) return;
    const p = n.props as Record<string, any>;
    if (n.type === Button) {
      out.push({ label: text(p.children), disabled: Boolean(p.disabled), onClick: p.onClick, type: p.type });
      return;
    }
    if (n.type === WidgetToolCall) return;
    if (typeof n.type === 'function') return walk((n.type as (p: unknown) => React.ReactNode)(p));
    walk(p.children);
  };
  walk(node);
  return out;
}

describe('AGUI-1b assistant chat view', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView, AgentChat, agentChatHref } = await import('./agent-chat'));
    ({ Button } = await import('@/components/ui/button'));
    ({ WidgetToolCall } = await import('./widgets/widget-tool-call'));
    ({ AssistantEmptyState } = await import('./assistant-shell'));
    AssistantPage = (await import('../../app/(assistant)/assistant/page')).default as never;
  });

  it('idle: transcript, Send only, disabled until there is text', () => {
    const p = props({
      items: [
        { kind: 'user', id: 'u1', text: 'Hi there', mode: 'run', delivery: 'delivered' },
        { kind: 'reasoning', id: 'r1', text: 'pondering', streaming: false },
        { kind: 'assistant', id: 'a1', text: 'Hello!', streaming: false },
      ],
    });
    const html = renderToStaticMarkup(React.createElement(AgentChatView, p));
    assert.match(html, /data-status="idle"/);
    assert.match(html, /Hi there/);
    assert.match(html, /<details[^>]*data-item="reasoning"/);
    assert.match(html, /Hello!/);
    assert.doesNotMatch(html, /Queued|Not sent/);
    assert.deepEqual(buttons(AgentChatView(p)).map((b) => [b.label, b.disabled]), [['Send', true]]);
    assert.deepEqual(
      buttons(AgentChatView({ ...p, draft: 'next' })).map((b) => [b.label, b.disabled]),
      [['Send', false]],
    );
  });

  it('running: Steer, Stop and Follow up; each calls its handler', () => {
    const calls: string[] = [];
    const p = props(
      { status: 'running' },
      { draft: 'more', onSteer: () => calls.push('steer'), onStop: () => calls.push('stop'), onSend: () => calls.push('send') },
    );
    const bs = buttons(AgentChatView(p));
    assert.deepEqual(bs.map((b) => b.label), ['Steer', 'Stop', 'Follow up']);
    assert.equal(bs[2].type, 'submit');
    bs[0].onClick!();
    bs[1].onClick!();
    assert.deepEqual(calls, ['steer', 'stop']);
    assert.match(renderToStaticMarkup(React.createElement(AgentChatView, p)), /Responding…/);
  });

  it('stopping: Stop and sending are disabled', () => {
    const bs = buttons(AgentChatView(props({ status: 'stopping' }, { draft: 'x' })));
    assert.deepEqual(bs.map((b) => [b.label, b.disabled]), [
      ['Steer', true],
      ['Stop', true],
      ['Follow up', true],
    ]);
  });

  it('shows each message delivery: queued, dropped, failed', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        props({
          status: 'running',
          items: [
            { kind: 'user', id: 'a', text: 'q', mode: 'followUp', delivery: 'queued' },
            { kind: 'user', id: 'b', text: 'd', mode: 'followUp', delivery: 'dropped' },
            { kind: 'user', id: 'c', text: 'f', mode: 'steer', delivery: 'failed' },
          ],
        }),
      ),
    );
    assert.match(html, /data-delivery="queued"[\s\S]*Queued — runs after the current reply/);
    assert.match(html, /data-delivery="dropped"[\s\S]*Not sent — the run ended first/);
    assert.match(html, /data-delivery="failed"[\s\S]*Steer[\s\S]*Not sent/);
  });

  it('tool calls render through the widget registry (fallback card, status mapped)', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        props({
          items: [
            { kind: 'tool', id: 't1', name: 'echo', argsText: '{"text":"hi"}', status: 'done', result: '{}' },
            { kind: 'tool', id: 't2', name: 'other', argsText: '', status: 'denied' },
            { kind: 'tool', id: 't3', name: 'late', argsText: '', status: 'detached' },
          ],
        }),
      ),
    );
    // Approved after the run ended: shown as not completed here, never as running.
    assert.match(html, /data-tool-status="detached"/);
    assert.doesNotMatch(html, /Running/);
    assert.match(html, /data-tool-status="done"/);
    assert.match(html, /data-widget="fallback"/);
    assert.match(html, /echo/);
    assert.match(html, /Done/);
    assert.match(html, /Failed/);
  });

  it('pending tool approval: Approve / Decline call back with the tool call id', () => {
    const decisions: Array<[string, boolean]> = [];
    const p = props(
      { status: 'running', pendingTools: [{ toolCallId: 'call-9', toolName: 'deleteThing', reason: 'tool_approval', args: null }] },
      { onToolDecision: (id, ok) => decisions.push([id, ok]) },
    );
    const bs = buttons(AgentChatView(p));
    bs.find((b) => b.label === 'Approve')!.onClick!();
    bs.find((b) => b.label === 'Decline')!.onClick!();
    assert.deepEqual(decisions, [
      ['call-9', true],
      ['call-9', false],
    ]);
    assert.match(renderToStaticMarkup(React.createElement(AgentChatView, p)), /data-pending-tool="call-9"/);
  });

  it('errors show as an alert with Dismiss', () => {
    let dismissed = false;
    const p = props(
      { error: { kind: 'conflict', status: 409, message: 'The run on this thread belongs to another session' } },
      { onDismissError: () => (dismissed = true) },
    );
    const html = renderToStaticMarkup(React.createElement(AgentChatView, p));
    assert.match(html, /role="alert"[^>]*data-error="conflict"/);
    assert.match(html, /belongs to another session/);
    buttons(AgentChatView(p)).find((b) => b.label === 'Dismiss')!.onClick!();
    assert.equal(dismissed, true);
  });

  it('a run cancelled without Stop, and a detached tool approval, show their messages', () => {
    for (const error of [
      { kind: 'cancelled' as const, message: RUN_CANCELLED_MESSAGE },
      { kind: 'detached' as const, message: TOOL_DETACHED_MESSAGE },
    ]) {
      const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ error })));
      assert.match(html, new RegExp(`role="alert"[^>]*data-error="${error.kind}"`));
      assert.ok(html.includes(error.kind === 'cancelled' ? 'Run cancelled' : 'no longer connected to the run'), html);
    }
  });

  it('connecting and setup error phases', () => {
    assert.match(renderToStaticMarkup(React.createElement(AgentChatView, props({}, { phase: 'connecting' }))), /Opening chat/);
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({}, { phase: 'error', setupError: 'Agent not found' })));
    assert.match(html, /role="alert"[^>]*>Agent not found/);
  });

  describe('/assistant page', () => {
    it('?agent=<key> opens the chat for that agent (and thread)', async () => {
      const el = await AssistantPage({ searchParams: Promise.resolve({ agent: 'alice', thread: 't-1' }) });
      assert.equal(el.type, AgentChat);
      assert.deepEqual(el.props, { agentId: 'alice', threadId: 't-1' });
      const el2 = await AssistantPage({ searchParams: Promise.resolve({ agent: ['bob', 'x'] }) });
      assert.deepEqual(el2.props, { agentId: 'bob', threadId: undefined });
    });

    it('no agent, or an invalid key, shows the empty state', async () => {
      for (const agent of [undefined, '', '../etc', 'a b', 'x'.repeat(201)]) {
        const el = await AssistantPage({ searchParams: Promise.resolve({ agent }) });
        assert.equal(el.type, AssistantEmptyState, String(agent));
      }
    });

    it('dot-only agent values (which would change the API path) show the empty state', async () => {
      for (const agent of ['.', '..', '...', ['..', 'alice']]) {
        const el = await AssistantPage({ searchParams: Promise.resolve({ agent }) });
        assert.equal(el.type, AssistantEmptyState, String(agent));
      }
      const dotted = await AssistantPage({ searchParams: Promise.resolve({ agent: 'a.b' }) });
      assert.equal(dotted.type, AgentChat);
    });

    it('an invalid thread id is reported as not found, not swapped for another thread', async () => {
      for (const thread of ['no/slash', '.', '..', '', 'x'.repeat(201)]) {
        const el = await AssistantPage({ searchParams: Promise.resolve({ agent: 'alice', thread }) });
        assert.notEqual(el.type, AgentChat, thread);
        assert.match(renderToStaticMarkup(el), /role="alert"[^>]*>Thread not found/, thread);
      }
    });
  });

  it('agentChatHref: the assistant path form /assistant/<agent>/<thread>', () => {
    assert.equal(agentChatHref('alice', 't-1'), '/assistant/alice/t-1');
    assert.equal(agentChatHref('alice', 't 2/x'), '/assistant/alice/t%202%2Fx');
  });
});
