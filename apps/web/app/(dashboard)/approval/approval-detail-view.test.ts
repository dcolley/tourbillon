/**
 * #130 B1/B2: the approval details page HTML carries no planted secret in any field, links are
 * URL-encoded (Test S7) and a deep payload renders small (Test S1). Rendered with
 * react-dom/server from the real loader output; next/link is stubbed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadApprovalDetail, type ApprovalDetail } from '@/lib/approval-detail';
import { PLANTED_VALUES, plantedRepo } from '@/lib/approval-detail-secrets.fixture';

describe('approval details page: rendered HTML', () => {
  let ApprovalDetailView: (p: { detail: ApprovalDetail }) => React.ReactNode;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === 'next/link') {
        return {
          __esModule: true,
          default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
            React.createElement('a', { href, ...rest }, children),
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ ApprovalDetailView } = (await import('./approval-detail-view')) as never);
    Module.prototype.require = originalRequire;
  });

  const render = (detail: ApprovalDetail) => renderToStaticMarkup(React.createElement(ApprovalDetailView, { detail }));
  /** HTML-escaped and URL-encoded forms too. */
  const forms = (v: string) => [v, encodeURIComponent(v), v.replace(/&/g, '&amp;')];

  it('no planted secret in any field of the page (decided approval with every field set)', async () => {
    const d = await loadApprovalDetail(plantedRepo(), 'company-a', 'appr-a');
    assert.ok(d);
    const html = render(d);
    assert.deepEqual(PLANTED_VALUES.filter((v) => forms(v).some((f) => html.includes(f))), []);
    // The fields are there, just scrubbed.
    assert.match(html, /Deploy with \[redacted\]/);
    assert.match(html, /401 for resume token \[redacted\]/);
    assert.match(html, /Rotate \[redacted\]/);
    assert.match(html, /password was \[redacted\]/);
  });

  it('pending approval (decision form shown) leaks nothing either; form action is encoded', async () => {
    const d = await loadApprovalDetail(
      plantedRepo({ id: 'appr a/1?x', status: 'pending', decidedAt: null }),
      'company-a',
      'appr a/1?x',
    );
    assert.ok(d);
    const html = render(d);
    assert.deepEqual(PLANTED_VALUES.filter((v) => forms(v).some((f) => html.includes(f))), []);
    assert.match(html, /action="\/api\/approvals\/appr%20a%2F1%3Fx\/decide"/);
  });

  it('issue links are URL-encoded (Test S7)', async () => {
    const repo = plantedRepo({ issueIds: ['iss/../x?y'] });
    repo.getIssues = async (companyId) => [
      { id: 'iss/../x?y', companyId, identifier: 'TOUR-9', title: 'T', status: 'todo', boardApprovalId: 'appr-a' },
    ];
    repo.getActivity = async () => [
      {
        id: 'l1', companyId: 'company-a', actorType: 'agent', actorId: 'agent-a', actorName: null,
        action: 'issue.updated', entityType: 'issue', entityId: 'iss/../x?y',
        details: { boardApprovalId: 'appr-a', status: 'blocked' }, createdAt: new Date('2026-10-08T09:01:00Z'),
      },
    ];
    const d = await loadApprovalDetail(repo, 'company-a', 'appr-a');
    assert.ok(d);
    const html = render(d);
    const hrefs = [...html.matchAll(/href="(\/issue\/[^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 2, html);
    for (const h of hrefs) assert.equal(h, '/issue/iss%2F..%2Fx%3Fy');
  });

  it('1,500-deep payload renders small with a truncation note (Test S1)', async () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 1500; i++) deep = { n: deep };
    const d = await loadApprovalDetail(plantedRepo({ payload: { title: 'Deep', deep } }), 'company-a', 'appr-a');
    assert.ok(d);
    const t0 = Date.now();
    const html = render(d);
    assert.ok(Date.now() - t0 < 2_000);
    assert.ok(html.length < 30_000, `${html.length}`);
    assert.match(html, /\[truncated: nested deeper than 12 levels\]/);
    assert.match(html, /cut for display/);
  });
});
