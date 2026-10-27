/**
 * DM-1/DM-2: the DM strip, the conversation modal's panes and the transcript chips. Markup via
 * react-dom/server (no DOM test library in the repo), like agent-chat.test.ts. The modal's panes
 * are stateless views (DmConversationList, DmThreadPane), so they render directly.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildConversations, readDmLastSeen, unreadPeerIds, type AgentDm, type DmStorageLike } from '../../lib/assistant/agent-dms';

const mapStore = (entries: Map<string, string> = new Map()): DmStorageLike => ({
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => {
    entries.set(key, value);
  },
});

type Activity = typeof import('./dm-activity');
type Peek = typeof import('./dm-peek-dialog');
type Hook = typeof import('./use-agent-dms');
let DmActivityStripView: Activity['DmActivityStripView'];
let DmConversationList: Peek['DmConversationList'];
let DmThreadPane: Peek['DmThreadPane'];
let fetchAgentDms: Hook['fetchAgentDms'];
let AgentChatView: typeof import('./agent-chat')['AgentChatView'];
let initialAgentChatState: typeof import('../../lib/agui/client/chat-state')['initialAgentChatState'];

const ceo = { id: 'a-ceo', name: 'CEO', urlKey: 'ceo' };
const cto = { id: 'a-cto', name: 'CTO', urlKey: 'cto' };
const pm = { id: 'a-pm', name: 'PM', urlKey: 'pm' };

/** CEO's two conversations: with CTO (m1 outbound, m2 inbound, m2 replies to m1) and with PM. */
const mails: AgentDm[] = [
  {
    id: 'p1',
    companyId: 'c1',
    fromAgentId: pm.id,
    toAgentId: ceo.id,
    body: 'Budget approved',
    inReplyTo: null,
    createdAt: '2026-10-25T10:04:00Z',
    fromAgent: pm,
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
  {
    id: 'm2',
    companyId: 'c1',
    fromAgentId: cto.id,
    toAgentId: ceo.id,
    body: 'Shipped **it**',
    inReplyTo: 'm1',
    createdAt: '2026-10-25T10:02:00Z',
    fromAgent: cto,
    toAgent: ceo,
  },
];

describe('DM-1/DM-2 DM strip, conversation panes and chips', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ DmActivityStripView } = await import('./dm-activity'));
    ({ DmConversationList, DmThreadPane } = await import('./dm-peek-dialog'));
    ({ fetchAgentDms } = await import('./use-agent-dms'));
    ({ AgentChatView } = await import('./agent-chat'));
    ({ initialAgentChatState } = await import('../../lib/agui/client/chat-state'));
  });

  it('strip is hidden without a summary; with one it shows the label and opens the modal', () => {
    assert.equal(DmActivityStripView({ summary: null, onOpen: () => {} }), null);
    let opened = 0;
    const view = DmActivityStripView({
      summary: { count: 2, peers: ['CTO'], morePeers: 0 },
      onOpen: () => {
        opened++;
      },
    }) as React.ReactElement<{ children: React.ReactElement<{ onClick: () => void }> }>;
    const html = renderToStaticMarkup(view as unknown as React.ReactElement);
    assert.match(html, /data-dm-strip/);
    assert.match(html, /2 DMs with CTO/);
    assert.doesNotMatch(html, /Agent Mail|room/i);
    (view.props.children as unknown as React.ReactElement<{ onClick: () => void }>).props.onClick();
    assert.equal(opened, 1);
  });

  it('conversation list: newest pair first, selected row marked, unread dot, filter; read-only', () => {
    const convs = buildConversations(mails, ceo.id);
    assert.deepEqual(convs.map((conv) => conv.peerId), [pm.id, cto.id]); // newest pair activity first
    const lastSeen = readDmLastSeen(mapStore(), ceo.id, convs.map((conv) => conv.peerId));
    lastSeen[cto.id] = Date.parse('2026-10-25T12:00:00Z'); // CTO read after its last message: no dot
    const html = renderToStaticMarkup(
      React.createElement(DmConversationList, {
        conversations: convs,
        selectedPeerId: convs[0].peerId, // the modal opens on the most recent conversation (modal default)
        filter: '',
        onFilterChange: () => {},
        onSelect: () => {},
        unread: unreadPeerIds(convs, lastSeen),
      }),
    );
    assert.match(html, /data-dm-filter/);
    assert.match(html, /PM/);
    assert.match(html, /CTO/);
    assert.match(html, /data-dm-conversation="a-pm" data-dm-selected="true"/);
    assert.match(html, /data-dm-unread/);
    assert.equal(html.match(/data-dm-unread/g)!.length, 1); // only PM has a message newer than its last-seen mark
    assert.doesNotMatch(html, /textarea|Send/i); // read-only: no composer anywhere in the list
    const filtered = renderToStaticMarkup(
      React.createElement(DmConversationList, {
        conversations: convs,
        selectedPeerId: convs[0].peerId,
        filter: 'cto',
        onFilterChange: () => {},
        onSelect: () => {},
        unread: [],
      }),
    );
    assert.match(filtered, /CTO/);
    assert.doesNotMatch(filtered, /PM/);
    const noMatch = renderToStaticMarkup(
      React.createElement(DmConversationList, {
        conversations: convs,
        selectedPeerId: null,
        filter: 'xyz',
        onFilterChange: () => {},
        onSelect: () => {},
        unread: [],
      }),
    );
    assert.match(noMatch, /No conversation matches that name\./);
  });

  it('thread pane: chronological, direction labels, quoted reply that jumps to the loaded parent', () => {
    const conv = buildConversations(mails, ceo.id).find((conv2) => conv2.peerId === cto.id)!;
    const html = renderToStaticMarkup(React.createElement(DmThreadPane, { agentId: ceo.id, conversation: conv }));
    assert.match(html, /data-dm-thread="a-cto"/);
    // Oldest first within the conversation; direction by attribute.
    assert.ok(html.indexOf('data-dm="m1"') < html.indexOf('data-dm="m2"'));
    assert.match(html, /data-dm="m1" data-dm-direction="to"/);
    assert.match(html, /data-dm="m2" data-dm-direction="from"/);
    assert.match(html, /<strong>it<\/strong>/); // body renders as markdown
    assert.match(html, /reply to: <a href="#dm-m1" data-dm-jump="m1"/); // jumps to the parent when loaded
    assert.doesNotMatch(html, /textarea|Send/i); // read-only: no composer
    const empty = renderToStaticMarkup(React.createElement(DmThreadPane, { agentId: ceo.id, conversation: null }));
    assert.match(empty, /No DMs to show here yet\./);
  });

  it('chat view merges chips into the transcript by time (display only)', () => {
    const noop = () => {};
    const d1: AgentDm = {
      id: 'd1',
      companyId: 'c1',
      fromAgentId: cto.id,
      toAgentId: ceo.id,
      body: 'Deploy is green',
      inReplyTo: null,
      createdAt: '2026-10-25T10:05:00Z',
      fromAgent: cto,
      toAgent: ceo,
    };
    const d2: AgentDm = { ...d1, id: 'd2', fromAgentId: ceo.id, toAgentId: cto.id, fromAgent: ceo, toAgent: cto, body: 'Nice, thanks', createdAt: '2026-10-25T10:06:00Z' };
    const state = {
      ...initialAgentChatState,
      items: [
        { kind: 'assistant' as const, id: 'a1', text: 'Before chips', streaming: false, at: '2026-10-25T10:00:00Z' },
        { kind: 'assistant' as const, id: 'a2', text: 'After chips', streaming: false, at: '2026-10-25T10:10:00Z' },
      ],
    };
    const base = {
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
    };
    const withChips = renderToStaticMarkup(
      React.createElement(AgentChatView, { ...base, agentId: ceo.id, dms: [d2, d1], dmThreadStartedAt: Date.parse('2026-10-25T09:00:00Z'), onOpenDm: noop }),
    );
    const iBefore = withChips.indexOf('Before chips');
    const iD1 = withChips.indexOf('data-dm-chip="d1"');
    const iD2 = withChips.indexOf('data-dm-chip="d2"');
    const iAfter = withChips.indexOf('After chips');
    assert.ok(iBefore > -1 && iD1 > iBefore && iD2 > iD1 && iAfter > iD2, 'chips sit between the messages by time, oldest first');
    assert.match(withChips, /Message from CTO/);
    assert.match(withChips, /Messaged CTO/);
    assert.match(withChips, /data-dm-open-conversation/); // each chip can open the conversation modal on itself
    // Chips only exist after the current thread start: a DM from before it is not chipped.
    const beforeStart = renderToStaticMarkup(
      React.createElement(AgentChatView, { ...base, agentId: ceo.id, dms: [d1], dmThreadStartedAt: Date.parse('2026-10-25T10:05:30Z') }),
    );
    assert.doesNotMatch(beforeStart, /data-dm-chip/);
    // Without DMs the transcript renders exactly as before DM-2 (chips are display-only).
    assert.equal(renderToStaticMarkup(React.createElement(AgentChatView, base)), renderToStaticMarkup(React.createElement(AgentChatView, { ...base, agentId: ceo.id, dms: [] })));
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
    assert.deepEqual((await fetchAgentDms('c1', ceo.id, { fetchImpl: ok })).map((m) => m.id), ['p1', 'm1', 'm2']);
    assert.deepEqual(urls, ['/api/companies/c1/agent-mail-client?agentId=a-ceo&limit=100']);
    const empty = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchAgentDms('c1', ceo.id, { fetchImpl: empty }), []);
    const denied = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(fetchAgentDms('c1', ceo.id, { fetchImpl: denied }), /HTTP 403/);
  });
});
