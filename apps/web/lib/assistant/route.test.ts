/**
 * UI-2b: assistant view routes. Canonical `/assistant/<agent-url-key>[/<threadId>]`; query links
 * and agent-id paths redirect to it; lookups stay inside the caller's company, and a missing
 * agent and another company's agent get the same not-found.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { cleanRouteSegment, decideAssistantRoute, parseAssistantPath } from './route';
import { assistantChatHref } from './sidebar-api';

interface Row {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
}
const ROWS: Row[] = [
  { id: '7d6f9c3e-1111-4c1a-9a51-000000000001', companyId: 'company-a', name: 'Chief Exec', urlKey: 'ceo' },
  { id: '7d6f9c3e-1111-4c1a-9a51-000000000002', companyId: 'company-a', name: 'Builder', urlKey: 'builder' },
  { id: '7d6f9c3e-2222-4c1a-9a51-000000000003', companyId: 'company-b', name: 'Other CEO', urlKey: 'other-ceo' },
  // Same url key in another company: never visible from company-a.
  { id: '7d6f9c3e-2222-4c1a-9a51-000000000004', companyId: 'company-b', name: 'B Builder', urlKey: 'shared-key' },
  { id: '7d6f9c3e-1111-4c1a-9a51-000000000005', companyId: 'company-a', name: 'A Shared', urlKey: 'shared-key' },
];
const [CEO, , OTHER, B_SHARED, A_SHARED] = ROWS;

let activeCompany: { id: string } | null = { id: 'company-a' };
const queries: Array<{ sql: string; params: unknown[] }> = [];
const dialect = new PgDialect();

class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`redirect ${location}`);
  }
}
class NotFoundSignal extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

type RouteServer = typeof import('./route-server');
let server: RouteServer;
type PageMod = { default: (props: unknown) => Promise<React.ReactElement> };
let rootPage: PageMod;
let agentPage: PageMod;
let threadPage: PageMod;

before(async () => {
  (globalThis as { React?: typeof React }).React = React;
  const schema = await import('@tourbillon/db/schema');
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: (cond: SQL) => ({
          limit: async (n: number) => {
            const q = dialect.sqlToQuery(cond);
            queries.push({ sql: q.sql, params: q.params });
            // Evaluate the only condition shape the lookup uses: company AND (id OR url key).
            assert.equal(q.sql, '("agents"."company_id" = $1 and ("agents"."id" = $2 or "agents"."url_key" = $3))');
            const [companyId, id, urlKey] = q.params as string[];
            return ROWS.filter((r) => r.companyId === companyId && (r.id === id || r.urlKey === urlKey))
              .slice(0, n)
              .map((r) => ({ id: r.id, urlKey: r.urlKey }));
          },
        }),
      }),
    }),
  };
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (this: unknown, id: string) {
    if (id === '@tourbillon/db') return { db: fakeDb, agents: schema.agents };
    if (id === '@/lib/company') return { getActiveCompanyOrNull: async () => activeCompany };
    if (id === 'next/navigation') {
      return {
        redirect: (location: string) => {
          throw new RedirectSignal(location);
        },
        notFound: () => {
          throw new NotFoundSignal();
        },
      };
    }
    return originalRequire.apply(this, arguments as unknown as [string]);
  };
  server = await import('./route-server');
  rootPage = await import('../../app/(assistant)/assistant/page') as unknown as PageMod;
  agentPage = await import('../../app/(assistant)/assistant/[agent]/page') as unknown as PageMod;
  threadPage = await import('../../app/(assistant)/assistant/[agent]/[threadId]/page') as unknown as PageMod;
});

beforeEach(() => {
  activeCompany = { id: 'company-a' };
  queries.length = 0;
});

/** Runs a page; returns 'render', the redirect location, or 'not-found'. */
async function visit(page: PageMod, props: { params?: Record<string, string>; searchParams?: Record<string, string | string[]> }) {
  try {
    const el = await page.default({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(props.searchParams ?? {}) });
    assert.ok(React.isValidElement(el));
    return 'render';
  } catch (err) {
    if (err instanceof RedirectSignal) return `redirect ${err.location}`;
    if (err instanceof NotFoundSignal) return 'not-found';
    throw err;
  }
}

describe('UI-2b assistant routes (pure)', () => {
  it('canonical path renders; agent id or query form redirects to the url-key path', () => {
    const agent = { id: CEO.id, urlKey: 'ceo' };
    assert.deepEqual(decideAssistantRoute({ agent, requestedKey: 'ceo', threadId: null, via: 'path' }), { kind: 'render', agent, threadId: null });
    // ASYNC-0: one conversation per agent; a thread link redirects to the agent path.
    assert.deepEqual(decideAssistantRoute({ agent, requestedKey: 'ceo', threadId: 't1', via: 'path' }), { kind: 'redirect', location: '/assistant/ceo' });
    assert.deepEqual(decideAssistantRoute({ agent, requestedKey: CEO.id, threadId: 't1', via: 'path' }), { kind: 'redirect', location: '/assistant/ceo' });
    assert.deepEqual(decideAssistantRoute({ agent, requestedKey: 'ceo', threadId: null, via: 'query' }), { kind: 'redirect', location: '/assistant/ceo' });
    assert.deepEqual(decideAssistantRoute({ agent: null, requestedKey: 'x', threadId: null, via: 'path' }), { kind: 'not-found' });
    assert.deepEqual(decideAssistantRoute({ agent, requestedKey: 'ceo', threadId: null, via: 'query', badThread: true }), { kind: 'not-found' });
  });

  it('URL segments: trimmed; empty, over-long, slash/backslash or control characters refused', () => {
    assert.equal(cleanRouteSegment(' ceo '), 'ceo');
    assert.equal(cleanRouteSegment(['a', 'b']), 'a');
    for (const bad of ['', '  ', '.', '..', '...', 'x'.repeat(201), 'a/b', 'a\\b', 'a\nb', '\u0000', undefined, null]) assert.equal(cleanRouteSegment(bad), null, JSON.stringify(bad));
  });

  it('client reads the selection from the path', () => {
    assert.deepEqual(parseAssistantPath('/assistant/ceo/t1'), { agent: 'ceo', thread: 't1' });
    assert.deepEqual(parseAssistantPath('/assistant/ceo'), { agent: 'ceo', thread: null });
    assert.deepEqual(parseAssistantPath('/assistant/a%20b/x%3Fy'), { agent: 'a b', thread: 'x?y' });
    for (const p of ['/assistant', '/assistant/', '/dashboard/ceo', '/assistant/ceo/t1/extra', '/assistant/%E0%A4%A', null]) {
      assert.deepEqual(parseAssistantPath(p), { agent: null, thread: null }, String(p));
    }
  });

  it('matches the AGUI-1b open link (#159 agentChatHref = assistantAgentPath): its paths parse back to the same key and thread', () => {
    for (const [key, thread] of [['alice', 't-1'], ['alice', 't 2'], ['cto', 'thr:1.2_3']]) {
      assert.deepEqual(parseAssistantPath(assistantChatHref(key, thread)), { agent: key, thread });
    }
  });

  it('sidebar links use the url key, so renaming an agent keeps its links', () => {
    const before = { name: 'Chief Exec', urlKey: 'ceo' };
    const renamed = { ...before, name: 'Chief Executive Officer' };
    assert.equal(assistantChatHref(before.urlKey, 't1'), '/assistant/ceo/t1');
    assert.equal(assistantChatHref(renamed.urlKey, 't1'), assistantChatHref(before.urlKey, 't1'));
    assert.equal(assistantChatHref('a b', 'x/y'), '/assistant/a%20b/x%2Fy');
  });
});

describe('UI-2b assistant route pages', () => {
  it('slug path renders the view', async () => {
    assert.equal(await visit(agentPage, { params: { agent: 'ceo' } }), 'render');
    assert.deepEqual(queries[0].params, ['company-a', 'ceo', 'ceo']);
  });

  it('ASYNC-0: slug + thread path redirects to the agent path (one conversation per agent)', async () => {
    assert.equal(await visit(threadPage, { params: { agent: 'ceo', threadId: 'thread-1' } }), 'redirect /assistant/ceo');
  });

  it('query links redirect to the slug path without the thread (by url key or agent id)', async () => {
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo', thread: 'thread-1' } }), 'redirect /assistant/ceo');
    assert.equal(await visit(rootPage, { searchParams: { agent: CEO.id, thread: 'thread-1' } }), 'redirect /assistant/ceo');
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo' } }), 'redirect /assistant/ceo');
    // The target is always a same-origin /assistant path.
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo', thread: '..x?y#z' } }), 'redirect /assistant/ceo');
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo', thread: '../x' } }), 'not-found', 'no slashes in a thread id');
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo', thread: '//evil.example' } }), 'not-found');
    assert.equal(await visit(rootPage, { searchParams: { agent: 'https://evil.example' } }), 'not-found');
    assert.equal(await visit(rootPage, {}), 'render', 'plain /assistant');
  });

  it('agent-id (UUID) paths redirect to the slug path', async () => {
    assert.equal(await visit(agentPage, { params: { agent: CEO.id } }), 'redirect /assistant/ceo');
    assert.equal(await visit(threadPage, { params: { agent: CEO.id, threadId: 'thread-1' } }), 'redirect /assistant/ceo');
  });

  it("another company's agent (by slug or id) gets the same not-found as a missing agent, and the lookup never leaves the company", async () => {
    const results = [
      await visit(agentPage, { params: { agent: OTHER.urlKey } }),
      await visit(agentPage, { params: { agent: OTHER.id } }),
      await visit(threadPage, { params: { agent: OTHER.id, threadId: 't' } }),
      await visit(rootPage, { searchParams: { agent: OTHER.urlKey, thread: 't' } }),
      await visit(rootPage, { searchParams: { agent: OTHER.id } }),
      await visit(agentPage, { params: { agent: 'no-such-agent' } }),
      await visit(rootPage, { searchParams: { agent: '7d6f9c3e-9999-4c1a-9a51-000000000009' } }),
    ];
    assert.deepEqual(results, Array(results.length).fill('not-found'));
    assert.ok(queries.every((q) => q.params[0] === 'company-a'), 'every lookup is scoped to the active company');
    // A url key used in both companies resolves to the caller's own agent only.
    assert.equal(await visit(rootPage, { searchParams: { agent: 'shared-key' } }), 'redirect /assistant/shared-key');
    assert.equal(await visit(rootPage, { searchParams: { agent: B_SHARED.id } }), 'not-found');
    assert.equal(await visit(rootPage, { searchParams: { agent: A_SHARED.id } }), 'redirect /assistant/shared-key');
    // Switching company flips which agents resolve.
    activeCompany = { id: 'company-b' };
    assert.equal(await visit(agentPage, { params: { agent: OTHER.urlKey } }), 'render');
    assert.equal(await visit(agentPage, { params: { agent: 'ceo' } }), 'not-found');
  });

  it('renaming an agent (name only) keeps the url key, so old links still resolve', async () => {
    const row = ROWS[0];
    const original = row.name;
    row.name = 'Chief Executive Officer';
    try {
      assert.equal(await visit(agentPage, { params: { agent: 'ceo' } }), 'render');
      assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo', thread: 't1' } }), 'redirect /assistant/ceo');
    } finally {
      row.name = original;
    }
  });

  it('no active company: pages render nothing of their own (the layout shows the company gate); no lookup', async () => {
    activeCompany = null;
    assert.equal(await visit(agentPage, { params: { agent: 'ceo' } }), 'render');
    assert.equal(await visit(rootPage, { searchParams: { agent: 'ceo' } }), 'render');
    assert.equal(queries.length, 0);
  });

  it('id match wins over a url key equal to another agent id (no ambiguity)', async () => {
    // Another agent whose url key happens to equal CEO's id, returned first by the query.
    ROWS.unshift({ id: 'impostor-id', companyId: 'company-a', name: 'Impostor', urlKey: CEO.id });
    try {
      const resolved = await server.findCompanyAgentByKey('company-a', CEO.id);
      assert.equal(resolved?.id, CEO.id);
      assert.equal(await visit(agentPage, { params: { agent: CEO.id } }), 'redirect /assistant/ceo');
    } finally {
      ROWS.shift();
    }
  });
});
