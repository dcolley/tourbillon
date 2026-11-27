/**
 * TB hotfix (tbhotfix-redact-CONTRACT.md) — what the browser / SSR markup shows for notices.
 *
 * Producer + renderer: rows are built from the REAL taskProgressSignalPayload (or, for M13, a
 * legacy raw stored row that bypasses the new builder), read back through
 * chatItemsFromStoredMessages (the reload path) and rendered by the real AgentChatView via
 * renderToStaticMarkup (the in-suite SSR canary, MUST-SSR).
 *
 * Red on main b5ca128: case 'notice' (agent-chat.tsx L149–165) dumps item.text; the payload
 * still has raw detail + model directives; there is no [data-error-details-toggle].
 *
 * CI: add to HARNESS_TEST_FILES in apps/web/scripts/run-harness-tests.mjs AND the scheduler
 * ci-coverage-s316-s4-s328-s4.test.ts harness pin (~L155).
 *
 * Toggle selectors match #364 / #370 FailureBlock: [data-error-details-toggle] with
 * aria-expanded, [data-error-details] absent when closed. Test seam: detailsOpen on the
 * notice item (same name as #364). Never a native <details> for the failed raw text.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatState } from '../../lib/agui/client/chat-state';
import { chatItemsFromStoredMessages, type StoredThreadMessage } from '../../lib/agui/client/thread-history';
import { taskProgressSignalPayload } from '@tourbillon/mastra/concierge-signal';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];

const noop = () => {};
function viewProps(state: Partial<AgentChatState>) {
  return {
    phase: 'ready' as const,
    setupError: null,
    state: { ...initialAgentChatState, ...state },
    draft: '',
    onDraftChange: noop,
    onSend: noop,
    onSteer: noop,
    onStop: noop,
    onToolDecision: noop,
    onDismissError: noop,
  };
}

const F = {
  sk: 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX',
  pass: 'S3cretPass-Fixture',
  ghp: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0Yi1ob3RmaXgtZml4dHVyZSIsImlhdCI6MX0.tbhotfix-not-a-real-signature',
};
const SECRETS = Object.values(F);
const ASK = 'Which region, EU or US?';
const RAW = `Error: connect ECONNREFUSED postgres://alice:${F.pass}@db.example.test:5432/app Authorization: Bearer ${F.sk} git=${F.ghp} jwt=${F.jwt} exit 137`;

const ev = {
  companyId: 'company-1',
  agentId: 'agent-1',
  chatTaskId: 'task-hotfix',
  runId: 'run-hotfix',
  title: 'Search AI news',
};

function storedFromPayload(id: string, stage: 'done' | 'failed' | 'waiting_on_user', detail?: string, title?: string): StoredThreadMessage {
  const p = taskProgressSignalPayload({
    ...ev,
    title: title ?? ev.title,
    stage,
    status: stage === 'failed' ? 'failed' : 'succeeded',
    detail,
  } as never);
  const rest = Object.fromEntries(Object.entries(p as object).filter(([k]) => k !== 'tagName' && k !== 'attributes' && k !== 'contents' && k !== 'transient'));
  return {
    id,
    role: 'signal',
    content: {
      format: 2,
      parts: [{ type: 'text', text: p.contents }],
      metadata: { signal: { id, type: 'reactive', tagName: p.tagName, attributes: p.attributes, contents: p.contents, ...rest } },
    },
    type: p.tagName,
  } as unknown as StoredThreadMessage;
}

/** Legacy pre-hotfix row: raw engine text + model directives, as main b5ca128 would have stored. */
function legacyFailedRow(id: string): StoredThreadMessage {
  const contents =
    `Background task "Search AI news" FAILED: ${RAW}. Tell the human it failed and offer a retry (resume re-queues it) — do NOT present it as waiting on their input.`;
  return {
    id,
    role: 'signal',
    content: {
      format: 2,
      parts: [{ type: 'text', text: contents }],
      metadata: {
        signal: {
          id,
          type: 'reactive',
          tagName: 'task-progress',
          attributes: { taskId: 'task-hotfix', runId: 'run-hotfix', stage: 'failed', status: 'failed' },
          contents,
        },
      },
    },
    type: 'task-progress',
  } as unknown as StoredThreadMessage;
}

function render(rows: StoredThreadMessage[], open = false): { html: string; stored: string } {
  let items = chatItemsFromStoredMessages(rows);
  if (open) items = items.map((i) => (i.kind === 'notice' ? ({ ...i, detailsOpen: true } as typeof i) : i));
  const html = renderToStaticMarkup(React.createElement(AgentChatView, viewProps({ items })));
  return { html, stored: JSON.stringify(rows) };
}

function assertNoSecrets(s: string, label: string) {
  for (const sec of SECRETS) {
    assert.ok(!s.includes(sec), `${label}: secret ${sec.slice(0, 8)}… must not appear`);
  }
}

const visible = (html: string) =>
  html.replace(/<[^>]*data-error-details[^>]*>[\s\S]*?<\/[^>]+>/g, '').replace(/<details[\s\S]*?<\/details>/g, '');

describe('TB hotfix: notice SSR / render is redacted and directive-free', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView } = await import('./agent-chat'));
  });

  it('MUST-3/M5/M15: failed notice shows a friendly line; no secret, no directives in SSR HTML', () => {
    const { html, stored } = render([storedFromPayload('n-fail', 'failed', RAW)]);
    assert.ok(html.includes('data-item="notice"') && html.includes('data-stage="failed"'));
    assert.equal((html.match(/data-item="notice"/g) ?? []).length, 1);
    assertNoSecrets(html, 'SSR failed notice');
    assertNoSecrets(stored, 'stored failed row (M9)');
    const vis = visible(html);
    assert.ok(/fail/i.test(vis), 'visible line says it failed');
    assert.ok(!/Tell the human/.test(html));
    assert.ok(!/do NOT present/i.test(html));
    assert.ok(!vis.includes('ECONNREFUSED'), 'raw stack is not in the default visible line');
  });

  it('MUST-3/M6/M7: failed notice uses the #364 toggle; body is absent when closed', () => {
    const { html } = render([storedFromPayload('n-fail', 'failed', RAW)], false);
    assert.ok(/data-error-details-toggle/.test(html), 'toggle control present');
    assert.ok(/aria-expanded="false"/.test(html), 'closed toggle is aria-expanded=false');
    assert.ok(!/data-error-details(?!-toggle)/.test(html), 'data-error-details body is absent when closed');
    const failedNotice = html.match(/data-item="notice"[^>]*data-stage="failed"[\s\S]*?(?=<div data-item=|$)/)?.[0] ?? html;
    assert.ok(!/<details[\s\S]*data-error-details/.test(failedNotice), 'not a native <details> (M6)');
  });

  it('MUST-3/M8: open toggle (detailsOpen seam) shows redacted technical text, no secrets', () => {
    const { html } = render([storedFromPayload('n-fail', 'failed', RAW)], true);
    assert.ok(/aria-expanded="true"/.test(html));
    const body = html.match(/<[^>]*data-error-details(?!-toggle)[^>]*>[\s\S]*?<\/[^>]+>/)?.[0] ?? '';
    assert.ok(body, 'data-error-details is present when open');
    assertNoSecrets(body, 'open toggle body');
    assertNoSecrets(html, 'open SSR page');
    assert.ok(body.includes('ECONNREFUSED') || body.includes('exit 137'), 'honest redacted technical text');
  });

  it('MUST-4/M13: a legacy raw stored row still renders redacted (defensive path)', () => {
    const { html, stored } = render([legacyFailedRow('n-legacy')], true);
    // The stored legacy row MAY still contain the secret (it was written before the hotfix);
    // the RENDERED SSR must not. (New rows are covered by M9 above.)
    assert.ok(stored.includes(F.sk), 'fixture: the legacy row really does contain the raw secret');
    assertNoSecrets(html, 'legacy row SSR, including open toggle');
    assert.ok(!/Tell the human/.test(html), 'directives stripped on the defensive path too');
  });

  it('MUST-1/M2: waiting_on_user notice redacts a secret in the ask and hides the model directive', () => {
    const { html, stored } = render([storedFromPayload('n-ask', 'waiting_on_user', `${ASK} credential=${F.sk}`)]);
    assert.ok(html.includes('data-stage="waiting_on_user"'));
    assertNoSecrets(html, 'needs-input SSR');
    assertNoSecrets(stored, 'needs-input stored');
    assert.ok(!/Ask them for exactly that/.test(html));
    assert.ok(visible(html).includes(ASK), 'exact ask is visible');
    assert.match(visible(html), /reply here/i);
  });

  it('MUST-1/M2: done notice redacts a secret in the title', () => {
    const { html, stored } = render([storedFromPayload('n-done', 'done', undefined, `Search AI news key=${F.sk}`)]);
    assert.ok(html.includes('data-stage="done"'));
    assertNoSecrets(html, 'done SSR');
    assertNoSecrets(stored, 'done stored');
  });

  it('MUST-7: needs-input without a secret still shows the ask and "reply here" (guard)', () => {
    const { html } = render([storedFromPayload('n-ask-clean', 'waiting_on_user', ASK)]);
    assert.ok(html.includes(ASK));
    assert.match(html, /reply here/i);
  });

  it('MUST-4/MUST-7: reload from stored rows is stable and still redacted', () => {
    const rows = [storedFromPayload('n-fail', 'failed', RAW)];
    const first = render(rows).html;
    const again = render(JSON.parse(JSON.stringify(rows)) as StoredThreadMessage[]).html;
    assert.equal(again, first, 'render depends only on the stored row');
    assertNoSecrets(again, 'reloaded SSR');
  });
});
