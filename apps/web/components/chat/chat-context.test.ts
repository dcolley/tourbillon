/**
 * UI-0: the Control Pane chat UI (floating button, popover pane, docked sidebar) renders only
 * when NEXT_PUBLIC_CONTROL_CHAT_ENABLED is exactly 'true'. The provider still provides the
 * chat context either way, so ChatPageContext callers keep working.
 * The repo has no DOM test library, so this renders with react-dom/server (effects do not run;
 * the provider's page context is seeded through `initialPageContext`).
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type ChatModule = typeof import('./chat-context');

const KEY = 'NEXT_PUBLIC_CONTROL_CHAT_ENABLED';
const original = process.env[KEY];

const defaultAgentPageContext = {
  contextType: 'agent' as const,
  contextId: 'agent-1',
  contextTitle: 'Ada',
  defaultAgentId: 'agent-1',
  defaultAgentName: 'Ada',
};

const sidebarTarget = {
  agentId: 'agent-1',
  agentName: 'Ada',
  contextType: 'agent' as const,
  contextId: 'agent-1',
  contextTitle: 'Ada',
};

describe('UI-0 Control Pane chat flag', () => {
  let chat: ChatModule;

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    chat = await import('./chat-context');
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  type ProviderProps = React.ComponentProps<ChatModule['ChatContextProvider']>;
  /** Children are passed as createElement's third argument. */
  const providerProps = (p: Omit<ProviderProps, 'children'>) => p as ProviderProps;

  function renderProvider(child?: React.ReactNode) {
    return renderToStaticMarkup(
      React.createElement(
        chat.ChatContextProvider,
        providerProps({ activeCompanyId: 'company-1', initialPageContext: defaultAgentPageContext }),
        React.createElement('main', { id: 'page' }, child ?? 'page body'),
      ),
    );
  }

  /** Reads the provided context, proving the provider still provides it. */
  function ContextProbe() {
    const ui = chat.useChatUi();
    return React.createElement(
      'span',
      { 'data-probe': 'chat-context' },
      `${ui.pageContext?.defaultAgentName ?? 'none'}|${ui.layoutMode}|${String(ui.open)}`,
    );
  }

  function sidebarContextValue(): React.ContextType<typeof chat.ChatUiContext> {
    const noop = () => {};
    return {
      openChat: noop,
      closeChat: noop,
      setPageContext: noop,
      pageContext: defaultAgentPageContext,
      layoutMode: 'sidebar',
      setLayoutMode: noop,
      target: sidebarTarget,
      open: true,
      handleAgentSwitch: noop,
      activeCompanyId: 'company-1',
    };
  }

  function renderSidebarSlot() {
    return renderToStaticMarkup(
      React.createElement(
        chat.ChatUiContext.Provider,
        { value: sidebarContextValue() },
        React.createElement(chat.ChatSidebarSlot),
      ),
    );
  }

  describe('ChatContextProvider', () => {
    for (const [label, value] of [
      ['unset', undefined],
      ['false', 'false'],
      ['other value', 'TRUE'],
    ] as const) {
      it(`flag ${label}: renders children, no chat button or pane, context still provided`, () => {
        if (value === undefined) delete process.env[KEY];
        else process.env[KEY] = value;
        const html = renderProvider(React.createElement(ContextProbe));
        assert.match(html, /<main id="page">/);
        assert.doesNotMatch(html, /Chat with/);
        assert.doesNotMatch(html, /<button/);
        // Context is provided; layout stays 'fab' (saved layouts are ignored) and closed.
        assert.match(html, /data-probe="chat-context">Ada\|fab\|false</);
      });
    }

    it("flag 'true': renders the floating chat button for the page's default agent", () => {
      process.env[KEY] = 'true';
      const html = renderProvider(React.createElement(ContextProbe));
      assert.match(html, /<main id="page">/);
      assert.match(html, /<button[^>]*title="Chat with Ada"/);
      assert.match(html, /Chat with agent/);
      // Unchanged default: 'sidebar' until the saved layout is read after mount.
      assert.match(html, /data-probe="chat-context">Ada\|sidebar\|false</);
    });

    it("flag 'true': no button when the page has no default agent", () => {
      process.env[KEY] = 'true';
      const html = renderToStaticMarkup(
        React.createElement(
          chat.ChatContextProvider,
          providerProps({ activeCompanyId: 'company-1' }),
          'x',
        ),
      );
      assert.doesNotMatch(html, /<button/);
    });
  });

  describe('resolveChatLayoutMode', () => {
    it("flag off: a saved 'sidebar' (or any) layout is ignored and storage is not read", () => {
      for (const saved of ['sidebar', 'popover', 'fab'] as const) {
        let reads = 0;
        const mode = chat.resolveChatLayoutMode(false, () => {
          reads += 1;
          return saved;
        });
        assert.equal(mode, 'fab');
        assert.equal(reads, 0);
      }
    });

    it('flag on: uses the saved layout (unchanged behaviour)', () => {
      for (const saved of ['sidebar', 'popover', 'fab'] as const) {
        assert.equal(chat.resolveChatLayoutMode(true, () => saved), saved);
      }
    });

    it("flag on, no window: falls back to the existing default 'sidebar'", () => {
      assert.equal(chat.resolveChatLayoutMode(true), 'sidebar');
    });
  });

  describe('ChatSidebarSlot', () => {
    it('flag unset: renders nothing even with a sidebar layout, open target', () => {
      delete process.env[KEY];
      assert.equal(renderSidebarSlot(), '');
    });

    it("flag 'false': renders nothing even with a sidebar layout, open target", () => {
      process.env[KEY] = 'false';
      assert.equal(renderSidebarSlot(), '');
    });

    it("flag 'true': renders the docked chat pane", () => {
      process.env[KEY] = 'true';
      const html = renderSidebarSlot();
      assert.notEqual(html, '');
      assert.match(html, /Ada/);
    });

    it('renders nothing outside the provider', () => {
      process.env[KEY] = 'true';
      assert.equal(renderToStaticMarkup(React.createElement(chat.ChatSidebarSlot)), '');
    });
  });
});
