/**
 * The board approvals list (/approval) renders titles, summaries, notes and HITLy errors from
 * the scrubbed approval read model. Rendered with react-dom/server; db, the active company and
 * next/link are stubbed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const RESUME = 'resume-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij01';
const NESTED = 'nested-secret-value-zyxwvutsrqponmlk';
const COMPANY_KEY = 'company-hitly-key-0123456789abcdef';
const BEARER = 'bearer-credential-0123456789abcdef';

const base = {
  companyId: 'co-a', type: 'hire_agent', requestedByAgentId: 'agent-a', decidedByUserId: null, issueIds: [],
  decidedAt: null, hitlyApprovalId: 'hitly-1', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const rows = [
  {
    approval: {
      ...base, id: 'appr-pending', status: 'pending', note: null,
      hitlyError: `HITLy ingest HTTP 400: https://tb.example/api/approvals/appr-pending/hitly-resume?token=${RESUME}`,
      payload: {
        title: `Hire CFO ${RESUME}`,
        summary: `Uses apiKey=${NESTED} and Authorization: Bearer ${BEARER} and ${COMPANY_KEY}`,
        hitlyResumeToken: RESUME,
        args: { config: { password: NESTED } },
      },
    },
    agent: { name: 'Alice' },
  },
  {
    approval: {
      ...base, id: 'appr-decided', status: 'approved', note: `ok, callback https://h.example/cb?token=${RESUME}`, hitlyError: null,
      payload: { title: `Decided ${NESTED}`, summary: 's', resumeToken: NESTED },
    },
    agent: { name: 'Bob' },
  },
];

describe('approvals list page: rendered HTML', () => {
  let ApprovalsPage: (props: Record<string, unknown>) => Promise<React.ReactElement | null>;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const builder = (fields?: Record<string, unknown>) => {
      const b: Record<string, unknown> = {};
      for (const m of ['from', 'leftJoin', 'where', 'orderBy', 'limit']) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(fields && 'approval' in fields ? rows : []).then(res);
      return b;
    };
    const table = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : String(p)) });
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === '@tourbillon/db') return { db: { select: builder }, approvals: table, agents: table, issues: table };
      if (id === 'drizzle-orm') return { eq: () => ({}), desc: () => ({}), inArray: () => ({}) };
      if (id === '@/lib/company' || id.endsWith('/lib/company')) {
        return {
          getActiveCompanyOrNull: async () => ({
            id: 'co-a',
            settings: { hitlyGate: { enabled: true, apiKey: COMPANY_KEY } },
          }),
        };
      }
      if (id === 'next/link') {
        return {
          __esModule: true,
          default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
            React.createElement('a', { href, ...rest }, children),
        };
      }
      if (id === 'next/navigation') return { redirect: () => {} };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ default: ApprovalsPage } = (await import('./page')) as never);
  });

  it('no resume token or secret-shaped value in any rendered field', async () => {
    const el = await ApprovalsPage({ searchParams: Promise.resolve({}) });
    assert.ok(el);
    const html = renderToStaticMarkup(el);
    for (const secret of [RESUME, NESTED, COMPANY_KEY, BEARER]) {
      for (const form of [secret, encodeURIComponent(secret)]) assert.ok(!html.includes(form), `${secret.slice(0, 12)}… leaked`);
    }
    assert.match(html, /Hire CFO/);
    assert.match(html, /Decided/);
    assert.match(html, /HITLy ingest error/);
  });
});
