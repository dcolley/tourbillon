/**
 * UI-3: Open in chat button. No DOM test library in the repo: the component has no hooks, so its
 * element is inspected directly, plus react-dom/server markup. The page wiring is checked from source.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VIEW_PREFERENCE_STORAGE_KEY } from '@/lib/view-preference';

type El = React.ReactElement<Record<string, any>>;
type Mod = typeof import('./open-in-chat-button');

describe('UI-3 OpenInChatButton', () => {
  let mod: Mod;
  const g = globalThis as { window?: unknown };
  const hadWindow = 'window' in g;
  const prevWindow = g.window;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    mod = await import('./open-in-chat-button');
  });

  afterEach(() => {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  });

  it('no default agent → no button', () => {
    for (const agentUrlKey of [undefined, null, '']) {
      assert.equal(mod.OpenInChatButton({ agentUrlKey, contextType: 'issue', contextId: 'i-1' }), null);
    }
    const html = renderToStaticMarkup(React.createElement(mod.OpenInChatButton, { contextType: 'goal', contextId: 'g-1' }));
    assert.equal(html, '');
  });

  it('with a default agent → link to that agent with the page context', () => {
    const el = mod.OpenInChatButton({
      agentUrlKey: 'alice',
      agentName: 'Alice',
      contextType: 'issue',
      contextId: 'i-1',
      contextTitle: 'Fix login',
    }) as El;
    assert.ok(el);
    assert.equal(el.props.href, '/assistant/alice?context=issue%3Ai-1&contextTitle=Fix+login');
    assert.equal(el.props['aria-label'], 'Open in chat with Alice');
    assert.equal(el.props['data-slot'], 'open-in-chat');
    const html = renderToStaticMarkup(el);
    assert.match(html, /<a [^>]*href="\/assistant\/alice\?context=issue%3Ai-1&amp;contextTitle=Fix\+login"/);
    assert.match(html, />Open in chat</);
  });

  it('following the link stores the assistant view as the preference', () => {
    const data = new Map<string, string>([[VIEW_PREFERENCE_STORAGE_KEY, 'control']]);
    g.window = { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } };
    const el = mod.OpenInChatButton({ agentUrlKey: 'alice', contextType: 'agent', contextId: 'a-1' }) as El;
    el.props.onClick();
    assert.equal(data.get(VIEW_PREFERENCE_STORAGE_KEY), 'assistant');
  });

  it('onOpen replaces the default action', () => {
    let opened = 0;
    const el = mod.OpenInChatButton({ agentUrlKey: 'alice', contextType: 'agent', contextId: 'a-1', onOpen: () => opened++ }) as El;
    el.props.onClick();
    assert.equal(opened, 1);
  });

  it('each Control Pane page offers it with the agent it gives ChatPageContext', () => {
    const root = join(__dirname, '..', '..', 'app', '(dashboard)');
    const pages: Array<[string, string, string]> = [
      ['agent/[urlKey]/page.tsx', 'agent', 'agent.urlKey'],
      ['issue/[issueId]/page.tsx', 'issue', 'assignee.urlKey'],
      ['issue/page.tsx', 'board', 'defaultAgent?.urlKey'],
      ['goal/[goalId]/page.tsx', 'goal', 'owner?.urlKey'],
      ['project/[projectId]/page.tsx', 'project', 'owner?.urlKey'],
      ['heartbeat/[runId]/page.tsx', 'heartbeat', 'agent?.urlKey'],
    ];
    for (const [file, type, key] of pages) {
      const src = readFileSync(join(root, file), 'utf8');
      const m = /<OpenInChatButton([\s\S]*?)\/>/.exec(src);
      assert.ok(m, `${file}: OpenInChatButton`);
      assert.match(m[1], new RegExp(`contextType="${type}"`), file);
      assert.ok(m[1].includes(`agentUrlKey={${key}}`), `${file}: agentUrlKey={${key}}`);
      const ctx = /<ChatPageContext([\s\S]*?)\/>/.exec(src);
      assert.ok(ctx, `${file}: ChatPageContext`);
      assert.match(ctx[1], new RegExp(`contextType="${type}"`), file);
      const agentVar = key.replace(/\??\.urlKey$/, '');
      assert.ok(ctx[1].includes(`defaultAgentId={${agentVar}`), `${file}: same default agent (${agentVar})`);
    }
  });
});
