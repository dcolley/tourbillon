/**
 * DM-1: DM strip and read-only peek in the assistant chat. Markup via react-dom/server (no DOM
 * test library in the repo), like agent-chat.test.ts.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentDm } from '../../lib/assistant/agent-dms';

type Activity = typeof import('./dm-activity');
type Peek = typeof import('./dm-peek-dialog');
type Hook = typeof import('./use-agent-dms');
let DmActivityStripView: Activity['DmActivityStripView'];
let DmActivity: Activity['DmActivity'];
let DmPeekList: Peek['DmPeekList'];
let fetchAgentDms: Hook['fetchAgentDms'];
let AgentChatView: typeof import('./agent-chat')['AgentChatView'];
let initialAgentChatState: typeof import('../../lib/agui/client/chat-state')['initialAgentChatState'];

const ceo = { id: 'a-ceo', name: 'CEO', urlKey: 'ceo' };
const cto = { id: 'a-cto', name: 'CTO', urlKey: 'cto' };
const mails: AgentDm[] = [
  {
    id: 'm2',
    companyId: 'c1',
    fromAgentId: cto.id,
    toAgentId: ceo.id,
    body: 'Shipped **it**',
    inReplyTo: 'm1aaaaaaaaaa',
    createdAt: '2026-10-25T10:02:00Z',
    fromAgent: cto,
    toAgent: ceo,
  },
  {
    id: 'm1',
    companyId: 'c1',
    fromAgentId: ceo.id,
    toAgentId: cto.id,
    body: 'Status?',
    inReplyTo: null,
    createdAt: '2026-10-25T10:01:00Z',
    fromAgent: ceo,
    toAgent: cto,
  },
];

describe('DM-1 DM strip and peek', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ DmActivityStripView, DmActivity } = await import('./dm-activity'));
    ({ DmPeekList } = await import('./dm-peek-dialog'));
    ({ fetchAgentDms } = await import('./use-agent-dms'));
    ({ AgentChatView } = await import('./agent-chat'));
    ({ initialAgentChatState } = await import('../../lib/agui/client/chat-state'));
  });

  it('strip is hidden with no DMs (also when they could not be read)', () => {
    assert.equal(renderToStaticMarkup(React.createElement(DmActivityStripView, { summary: null, onOpen: () => {} })), '');
    assert.equal(renderToStaticMarkup(React.createElement(DmActivity, { agentId: ceo.id, mails: [] })), '');
    assert.equal(renderToStaticMarkup(React.createElement(DmActivity, { agentId: ceo.id, mails: [], error: 'HTTP 404' })), '');
  });

  it('strip shows the DM summary and opens the peek on click', () => {
    let opened = 0;
    const el = DmActivityStripView({ summary: { count: 2, peers: ['CTO'], morePeers: 0 }, onOpen: () => opened++ })!;
    const html = renderToStaticMarkup(el);
    assert.match(html, /data-dm-strip/);
    assert.match(html, /2 DMs with CTO/);
    assert.doesNotMatch(html, /Agent Mail|room/i);
    const button = (el.props as { children: React.ReactElement<{ onClick: () => void }> }).children;
    button.props.onClick();
    assert.equal(opened, 1);
    assert.match(renderToStaticMarkup(React.createElement(DmActivity, { agentId: ceo.id, mails })), /2 DMs with CTO/);
  });

  it('peek groups by peer with To / From, body, time and reply hint; no composer or send', () => {
    const html = renderToStaticMarkup(React.createElement(DmPeekList, { agentId: ceo.id, mails }));
    assert.match(html, /data-dm-peer="a-cto"/);
    // Oldest first within the conversation.
    assert.ok(html.indexOf('data-dm="m1"') < html.indexOf('data-dm="m2"'));
    assert.match(html, /data-dm="m1" data-dm-direction="to"/);
    assert.match(html, /data-dm="m2" data-dm-direction="from"/);
    assert.match(html, /<strong>it<\/strong>/);
    assert.match(html, /dateTime="2026-10-25T10:02:00Z"/);
    assert.match(html, /↳ In reply to m1aaaaaa…/);
    assert.doesNotMatch(html, /<textarea|<form|<input|Send/);
  });

  it('peek empty states are quiet', () => {
    assert.match(renderToStaticMarkup(React.createElement(DmPeekList, { agentId: ceo.id, mails: [] })), /No DMs yet\./);
    assert.match(
      renderToStaticMarkup(React.createElement(DmPeekList, { agentId: ceo.id, mails: [], error: 'HTTP 500' })),
      /DMs could not be loaded\./,
    );
    assert.match(
      renderToStaticMarkup(React.createElement(DmPeekList, { agentId: ceo.id, mails, error: 'HTTP 500' })),
      /data-dm-stale/,
    );
  });

  it('chat view renders the DM slot above the message list', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      React.createElement(AgentChatView, {
        phase: 'ready',
        setupError: null,
        state: { ...initialAgentChatState, items: [{ kind: 'assistant', id: 'a1', text: 'Hello!', streaming: false }] },
        draft: '',
        onDraftChange: noop,
        onSend: noop,
        onSteer: noop,
        onStop: noop,
        onToolDecision: noop,
        onDismissError: noop,
        dmActivity: React.createElement('div', { 'data-test-dm': true }, 'dm slot'),
      }),
    );
    assert.ok(html.indexOf('data-test-dm') > -1 && html.indexOf('data-test-dm') < html.indexOf('Hello!'));
  });

  it('route view hands the active company to the chat (no company, no DM strip)', async () => {
    const { assistantRouteView } = await import('./assistant-route-view');
    const agent = { id: ceo.id, urlKey: 'ceo' };
    const withCo = assistantRouteView({ kind: 'render', agent, threadId: null }, { companyId: 'c1' }) as React.ReactElement<{ companyId?: string }>;
    assert.equal(withCo.props.companyId, 'c1');
    const without = assistantRouteView({ kind: 'render', agent, threadId: null }) as React.ReactElement<{ companyId?: string }>;
    assert.equal('companyId' in without.props, false);
  });

  it('fetch reads mails from the board-session route and fails on non-2xx', async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ mails }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual((await fetchAgentDms('c1', ceo.id, { fetchImpl: ok })).map((m) => m.id), ['m2', 'm1']);
    assert.deepEqual(urls, ['/api/companies/c1/agent-mail-client?agentId=a-ceo&limit=100']);
    const empty = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchAgentDms('c1', ceo.id, { fetchImpl: empty }), []);
    const denied = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(fetchAgentDms('c1', ceo.id, { fetchImpl: denied }), /HTTP 403/);
  });
});
