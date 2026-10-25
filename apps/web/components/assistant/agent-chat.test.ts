/**
 * AGUI-1b: assistant chat view (stateless part) and what the assistant path pages render.
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
let assistantRouteView: typeof import('./assistant-route-view').assistantRouteView;
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
    ({ assistantRouteView } = await import('./assistant-route-view'));
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

  it('plain tool calls (no registered widget) render as tool-state cards', () => {
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
    assert.match(html, /data-tool-card="true" data-tool-state="done" data-tool-call-id="t1"/);
    assert.match(html, /data-tool-state="declined" data-tool-call-id="t2"/);
    assert.match(html, /data-tool-state="detached" data-tool-call-id="t3"/);
    assert.match(html, /echo/);
    assert.match(html, /Done/);
    assert.match(html, /Declined/);
  });

  it('CHAT-2: assistant text renders as markdown; user text stays plain', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        props({
          items: [
            { kind: 'user', id: 'u1', text: '**not bold** <b>x</b>', mode: 'run', delivery: 'delivered' },
            {
              kind: 'assistant',
              id: 'a1',
              text: 'Here is **bold**\n\n```sh\nls -la\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>x()</script>',
              streaming: false,
            },
          ],
        }),
      ),
    );
    assert.match(html, /data-item="user"[\s\S]*\*\*not bold\*\* &lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /data-item="assistant"[\s\S]*<strong>bold<\/strong>/);
    assert.match(html, /data-code-block="true" data-language="sh"/);
    assert.match(html, /data-table-block="true"/);
    assert.doesNotMatch(html, /<script/i);
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

  describe('assistant path pages', () => {
    const agent = { id: '00000000-0000-4000-8000-000000000001', urlKey: 'alice' };

    it('a resolved /assistant/<key>/<thread> renders the chat: API by agent id, link by url key', () => {
      const el = assistantRouteView({ kind: 'render', agent, threadId: 't-1' });
      assert.equal(el.type, AgentChat);
      assert.deepEqual(el.props, { agentId: agent.id, agentKey: 'alice', threadId: 't-1' });
      assert.equal(el.key, `${agent.id}:t-1`);
    });

    it('a resolved /assistant/<key> renders the chat without a thread (latest thread opens)', () => {
      const el = assistantRouteView({ kind: 'render', agent, threadId: null });
      assert.equal(el.type, AgentChat);
      assert.deepEqual(el.props, { agentId: agent.id, agentKey: 'alice', threadId: undefined });
      assert.equal(el.key, `${agent.id}:`);
    });

    it('another agent or thread gets a different key (the chat remounts, no state carried over)', () => {
      const keys = new Set(
        [
          assistantRouteView({ kind: 'render', agent, threadId: 't-1' }),
          assistantRouteView({ kind: 'render', agent, threadId: 't-2' }),
          assistantRouteView({ kind: 'render', agent, threadId: null }),
          assistantRouteView({ kind: 'render', agent: { id: 'other', urlKey: 'bob' }, threadId: 't-1' }),
        ].map((el) => el.key),
      );
      assert.equal(keys.size, 4);
    });

    it('no company selected (null) shows the empty state, never the chat', () => {
      assert.equal(assistantRouteView(null).type, AssistantEmptyState);
    });

    it('both path pages render through assistantRouteView after resolving the route; /assistant does not render the chat', async () => {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const read = (rel: string) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const agentPage = await read('../../app/(assistant)/assistant/[agent]/page.tsx');
      const threadPage = await read('../../app/(assistant)/assistant/[agent]/[threadId]/page.tsx');
      // UI-3: both also pass the Open in chat context read from the search params.
      assert.match(agentPage, /assistantRouteView\(applyAssistantRoute\(await resolveAssistantRoute\(\{ agentKey: agent, via: 'path' \}\)\), \{ context \}\)/);
      assert.match(threadPage, /assistantRouteView\(applyAssistantRoute\(await resolveAssistantRoute\(\{ agentKey: agent, threadId, via: 'path' \}\)\), \{ context \}\)/);
      for (const page of [agentPage, threadPage]) assert.match(page, /const context = parseOpenInChatContext\(await searchParams\);/);
      const queryPage = await read('../../app/(assistant)/assistant/page.tsx');
      assert.doesNotMatch(queryPage, /AgentChat|assistantRouteView/);
    });
  });

  it('agentChatHref: the assistant path form /assistant/<agent>/<thread>', () => {
    assert.equal(agentChatHref('alice', 't-1'), '/assistant/alice/t-1');
    assert.equal(agentChatHref('alice', 't 2/x'), '/assistant/alice/t%202%2Fx');
  });

  it('AgentChat links by url key when given (agentKey), else by agentId', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const src = await readFile(fileURLToPath(new URL('./agent-chat.tsx', import.meta.url)), 'utf8');
    assert.match(src, /const linkKey = agentKey \?\? agentId;/);
    assert.match(src, /agentChatHref\(linkKey, ref\.threadId\)/);
  });
});

describe('UI-3 context chip in the assistant composer', () => {
  let ContextChip: View['ContextChip'];
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView, AgentChat, ContextChip } = await import('./agent-chat'));
    ({ Button } = await import('@/components/ui/button'));
    ({ WidgetToolCall } = await import('./widgets/widget-tool-call'));
    ({ assistantRouteView } = await import('./assistant-route-view'));
  });

  const issue = { contextType: 'issue' as const, contextId: 'i-1', contextTitle: 'Fix login' };

  it('shows the page context as a chip above the message box', () => {
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({}, { contextChip: issue })));
    assert.match(html, /data-slot="context-chip"[^>]*data-context-type="issue"[^>]*data-context-id="i-1"/);
    assert.match(html, /Issue: Fix login/);
    assert.match(html, /aria-label="Remove context"/);
    assert.ok(html.indexOf('data-slot="context-chip"') < html.indexOf('aria-label="Message"'));
  });

  it('no context → no chip', () => {
    for (const contextChip of [undefined, null]) {
      const html = renderToStaticMarkup(React.createElement(AgentChatView, props({}, { contextChip })));
      assert.doesNotMatch(html, /context-chip|Remove context/);
    }
  });

  it('the chip can be removed', () => {
    let removed = 0;
    const bs = buttons(AgentChatView(props({}, { contextChip: issue, onRemoveContext: () => removed++ })));
    assert.deepEqual(bs.map((b) => b.label), ['', 'Send']);
    bs[0].onClick!();
    assert.equal(removed, 1);
    const chip = ContextChip({ context: { contextType: 'board', contextId: 'board' } });
    assert.match(renderToStaticMarkup(chip), /Issue board/);
  });

  it('an Open in chat context reaches the chat as its starting context', () => {
    const agent = { id: 'agent-1', urlKey: 'alice' };
    const el = assistantRouteView({ kind: 'render', agent, threadId: null }, { context: issue });
    assert.equal(el.type, AgentChat);
    assert.deepEqual(el.props, { agentId: 'agent-1', agentKey: 'alice', threadId: undefined, initialContext: issue });
    assert.equal(el.key, 'agent-1:');
    const plain = assistantRouteView({ kind: 'render', agent, threadId: null }, { context: null });
    assert.equal('initialContext' in plain.props, false);
  });
});
