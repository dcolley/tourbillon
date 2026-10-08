/**
 * The approval details page itself (page.tsx): it renders the shared loader's output with the
 * real secret-value source, so a page that skipped the secret values would show them. Also the
 * vault-unavailable state (#130 B3) end to end through the page. next/link, the active company
 * and the repo factory are stubbed; the loader and view are real.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalDetailRepo } from '@/lib/approval-detail';
import { REDACTION_UNAVAILABLE } from '@/lib/approval-redaction';
import { PLANTED_VALUES, plantedRepo } from '@/lib/approval-detail-secrets.fixture';
import {
  DUMMY_VAULT_KEY,
  OTHER_DUMMY_VAULT_KEY,
  captureLogs,
  plantedSecretRows,
  vaultBackedRepo,
  withVaultKey,
} from '@/lib/approval-detail-vault.fixture';

type PageFn = (p: {
  params: Promise<{ approvalId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<React.ReactElement | null>;

describe('approval details page (page.tsx)', () => {
  let Page: PageFn;
  let repo: ApprovalDetailRepo = plantedRepo();

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: unknown, id: string) {
      if (id === 'next/link') {
        return {
          __esModule: true,
          default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
            React.createElement('a', { href, ...rest }, children),
        };
      }
      if (id.endsWith('/lib/company')) return { getActiveCompanyOrNull: async () => ({ id: 'company-a' }) };
      if (id.endsWith('/lib/approval-detail-repo')) return { createApprovalDetailRepo: () => repo };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    try {
      ({ default: Page } = (await import('./page')) as never);
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  const render = async (approvalId = 'appr-a') => {
    const el = await Page({ params: Promise.resolve({ approvalId }), searchParams: Promise.resolve({}) });
    assert.ok(el);
    return { el, html: renderToStaticMarkup(el) };
  };
  const forms = (v: string) => [v, encodeURIComponent(v), v.replace(/&/g, '&amp;')];
  const leaks = (text: string) => PLANTED_VALUES.filter((v) => forms(v).some((f) => text.includes(f)));

  it('renders with the repo secret values applied (vault and provider values never shown)', async () => {
    repo = plantedRepo();
    const { el, html } = await render();
    assert.deepEqual(leaks(html), []);
    assert.deepEqual(leaks(JSON.stringify(el.props)), []);
    assert.match(html, /Deploy with \[redacted\]/);
    assert.match(html, /vault \[redacted\], provider \[redacted\]/);
    assert.match(html, /Rotate \[redacted\]/);
    assert.doesNotMatch(html, /redaction unavailable/);
  });

  it('secret values come from the real repo too (one vault row source, one provider row)', async () => {
    const rows = await plantedSecretRows();
    repo = vaultBackedRepo(rows);
    const { html } = await withVaultKey(DUMMY_VAULT_KEY, () => render());
    assert.deepEqual(leaks(html), []);
    assert.match(html, /vault \[redacted\], provider \[redacted\]/);
  });

  for (const [name, key, corrupt] of [
    ['key unset', null, false],
    ['wrong key', OTHER_DUMMY_VAULT_KEY, false],
    ['corrupt row', DUMMY_VAULT_KEY, true],
  ] as const) {
    it(`${name}: page renders with free text hidden; status, dates and ids shown; no planted value`, async () => {
      const rows = await plantedSecretRows({ corrupt });
      repo = vaultBackedRepo(rows);
      const { result, logs } = await captureLogs(() => withVaultKey(key, () => render()));
      const { el, html } = result;
      assert.deepEqual(leaks(html), []);
      assert.deepEqual(leaks(JSON.stringify(el.props)), []);
      assert.deepEqual(leaks(logs), []);
      assert.ok(html.split(REDACTION_UNAVAILABLE).length - 1 >= 6, html);
      assert.match(html, /stored secrets could not be loaded/);
      assert.match(html, /appr-a/); // approval id
      assert.match(html, /hitly-1/);
      assert.match(html, /TOUR-1/);
      assert.match(html, /Alice/);
      assert.match(html, /request_board_approval/);
      assert.match(html, /2026/); // dates
      assert.match(html, /[Rr]ejected/);
      // #131: related approvals still listed (link + status), titles hidden.
      assert.match(html, /href="\/approval\/appr-r1"/);
      assert.match(html, /href="\/approval\/appr-r2"/);
    });
  }

  it('unknown id and malformed id → not found', async () => {
    repo = plantedRepo();
    await assert.rejects(Page({ params: Promise.resolve({ approvalId: 'appr-zzz' }), searchParams: Promise.resolve({}) }), /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/);
    await assert.rejects(Page({ params: Promise.resolve({ approvalId: 'a\u0000b' }), searchParams: Promise.resolve({}) }), /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/);
  });
});
