/**
 * S297-S6 (Refs #297): the chat-header avatar renders THROUGH the container.
 *
 * Bug class this pins: assistantRouteView spreads `agentName`/`avatar` into <AgentChat>, but the
 * container neither declared nor forwarded them, and TS does not excess-check the conditional JSX
 * spread — the avatar silently never rendered. A view-level test (props straight into
 * AgentChatView) cannot catch this; only a render that goes through assistantRouteView → AgentChat
 * → AgentChatView can. Same pass pins the CHAT-SEND-KEY prop (sendKeyMode) riding the same edge.
 *
 * No DOM library in the repo: react-dom/server. S302-S1 (Refs #302): `useAgentChat` (the real one
 * starts every mount in 'connecting', so the view would early-return "Opening chat…") and
 * `useChatSendKeyMode` (reads the browser store) are stubbed through the container module's
 * exported `__test__` seam — typed, so a renamed hook or import path fails at type-check — instead
 * of intercepting require by module-specifier string, and restored in after() so the stubs cannot
 * leak to anything else in this file's process.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState } from '../../lib/agui/client/chat-state';
import type { AgentAvatarConfig } from '@tourbillon/shared/agent-avatar';

const avatarConfig: AgentAvatarConfig = { shape: 'blob-3', color: '#14b8a6' };
const agent = { id: 'a-1', urlKey: 'alice', name: 'Ada Lovelace', avatar: avatarConfig };

describe('S297-S6 chat-header avatar renders through the AgentChat container', () => {
  let assistantRouteView: typeof import('./assistant-route-view').assistantRouteView;
  let restore: () => void = () => {};

  before(async () => {
    (globalThis as { React?: unknown }).React = React;

    // S302-S1: stub the container's two live hooks through its exported test seam. The seam is
    // typed from agent-chat.tsx's imports, so both stubs are compile-checked against the real hook
    // signatures; the container reads the seam at call time and the originals are restored below.
    const mod = await import('./agent-chat');
    const originals = { useAgentChat: mod.__test__.useAgentChat, useChatSendKeyMode: mod.__test__.useChatSendKeyMode };
    restore = () => Object.assign(mod.__test__, originals);

    // A ready chat with no thread (keeps the model picker / DM modal out of the tree). The
    // container only reads these fields during render; the send/abort callbacks stay uncalled.
    mod.__test__.useAgentChat = () => ({
      phase: 'ready',
      setupError: null,
      thread: null,
      state: initialAgentChatState,
      send: () => undefined,
      steer: () => undefined,
      abort: () => undefined,
      respondToTool: () => undefined,
      answerWidget: () => undefined,
      dismissWidget: () => undefined,
      clearError: () => undefined,
      loadPrevious: () => undefined,
    });
    // Non-default mode: if the container ever drops the sendKeyMode prop, the view falls back
    // to 'enter_sends' and the data-send-key-mode assertion below goes RED.
    mod.__test__.useChatSendKeyMode = () => ['mod_enter_sends', () => {}];

    ({ assistantRouteView } = await import('./assistant-route-view'));
  });

  after(() => restore());

  it('the route view spreads avatar + agentName onto the AgentChat element (chain entry)', () => {
    const el = assistantRouteView({ kind: 'render', agent, threadId: null });
    assert.equal(el.type.name, 'AgentChat');
    assert.equal(el.props.avatar, avatarConfig);
    assert.equal(el.props.agentName, 'Ada Lovelace');
  });

  it('rendered through the container, the header shows the chosen avatar with the agent initials', () => {
    const html = renderToStaticMarkup(assistantRouteView({ kind: 'render', agent, threadId: null }));
    assert.match(html, /data-chat-chrome/, 'the chrome bar renders');
    assert.match(html, /data-avatar="custom"/, 'the header avatar renders (the S297-S6 bug: it never did)');
    assert.match(html, /data-avatar-shape="blob-3"/);
    assert.match(html, /data-avatar-color="#14b8a6"/);
    assert.match(html, /data-avatar="custom"[\s\S]*?>AL</, 'initials come from the forwarded agentName (dropping it falls back to "Agent" → "A")');
    // CHAT-SEND-KEY wiring intact on the same container → view edge.
    assert.match(html, /data-send-key-mode="mod_enter_sends"/);
  });

  it('no avatar configured: chrome renders (menu) without any custom avatar', () => {
    const html = renderToStaticMarkup(
      assistantRouteView({ kind: 'render', agent: { ...agent, avatar: null }, threadId: null }),
    );
    assert.match(html, /data-chat-chrome/);
    assert.doesNotMatch(html, /data-avatar="custom"/);
  });
});
