/**
 * CTX-1: composer context meter — controller (load, newest wins, keep last good value) and the
 * stateless view (server render; no DOM library in this repo).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMeterView } from './context-meter';
import { contextMeterUrl, createContextMeterController } from './context-meter-controller';
import type { ThreadContextMeter } from '@/lib/assistant/context-meter';

(globalThis as { React?: typeof React }).React = React;

const METER: ThreadContextMeter = {
  usedTokens: 12_400,
  limitTokens: 128_000,
  limitSource: 'model',
  trimAtTokens: 117_952,
  messageTokens: 4_400,
  overheadTokens: 8_000,
  outputReserve: 2_048,
  windowMessages: 6,
  totalMessages: 6,
  observeAfterTokens: null,
  level: 'ok',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('context meter controller', () => {
  it('loads the thread context route', async () => {
    const urls: string[] = [];
    const c = createContextMeterController({
      agentId: 'a 1',
      threadId: 't/1',
      fetch: async (url) => {
        urls.push(url);
        return json({ meter: METER });
      },
    });
    assert.equal(c.getSnapshot().status, 'loading');
    await c.load();
    assert.deepEqual(urls, [contextMeterUrl('a 1', 't/1')]);
    assert.equal(urls[0], '/api/assistant/agents/a%201/threads/t%2F1/context');
    assert.equal(c.getSnapshot().status, 'ready');
    assert.equal(c.getSnapshot().meter?.limitTokens, 128_000);
  });

  it('keeps the last good meter when a reload fails; errors only without one', async () => {
    let fail = false;
    const c = createContextMeterController({
      agentId: 'a',
      threadId: 't',
      fetch: async () => (fail ? json({ error: 'nope' }, 500) : json({ meter: METER })),
    });
    await c.load();
    fail = true;
    await c.load();
    assert.equal(c.getSnapshot().status, 'ready');
    assert.equal(c.getSnapshot().meter?.usedTokens, 12_400);

    const bad = createContextMeterController({ agentId: 'a', threadId: 't', fetch: async () => { throw new Error('offline'); } });
    await bad.load();
    assert.equal(bad.getSnapshot().status, 'error');
  });

  it('the newest load wins', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const c = createContextMeterController({
      agentId: 'a',
      threadId: 't',
      fetch: () => new Promise<Response>((r) => resolvers.push(r)),
    });
    const first = c.load();
    const second = c.load();
    resolvers[1](json({ meter: { ...METER, usedTokens: 2 } }));
    await second;
    resolvers[0](json({ meter: { ...METER, usedTokens: 1 } }));
    await first;
    assert.equal(c.getSnapshot().meter?.usedTokens, 2);
  });

  it('notifies subscribers', async () => {
    const c = createContextMeterController({ agentId: 'a', threadId: 't', fetch: async () => json({ meter: METER }) });
    let n = 0;
    const off = c.subscribe(() => n++);
    await c.load();
    off();
    await c.load();
    assert.equal(n, 1);
  });
});

describe('ContextMeterView', () => {
  it('renders used / limit with a meter role and tooltip', () => {
    const html = renderToStaticMarkup(React.createElement(ContextMeterView, { snapshot: { status: 'ready', meter: METER } }));
    assert.match(html, /~12\.4k \/ 128k/);
    assert.match(html, /role="meter"/);
    assert.match(html, /aria-valuemax="128000"/);
    assert.match(html, /data-context-meter="ok"/);
    assert.match(html, /data-limit-source="model"/);
    assert.match(html, /title="Context: ~12\.4k of 128k tokens \(estimate\)/);
    assert.match(html, /width:10%/);
  });

  it('shows the level and the env-limit source', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContextMeterView, {
        snapshot: { status: 'ready', meter: { ...METER, level: 'near', limitSource: 'env', limitTokens: 120_000 } },
      }),
    );
    assert.match(html, /data-context-meter="near"/);
    assert.match(html, /bg-amber-500/);
    assert.match(html, /no context window configured/);
  });

  it('placeholder while loading, nothing on error', () => {
    assert.match(renderToStaticMarkup(React.createElement(ContextMeterView, { snapshot: { status: 'loading', meter: null } })), /data-context-meter="loading"/);
    assert.equal(renderToStaticMarkup(React.createElement(ContextMeterView, { snapshot: { status: 'error', meter: null } })), '');
  });
});
