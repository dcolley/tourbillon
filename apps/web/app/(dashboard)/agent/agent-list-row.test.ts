/**
 * #119 soft: the agents list row shows the Active/Inactive toggle only for active and paused
 * agents. Archived agents (setAgentActive refuses to activate them, #119 B1) and pending_approval
 * agents get the read-only status badge instead. Rendered with react-dom/server; the server
 * actions and next/link are stubbed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const toggleAgentActiveAction = async () => {};
const triggerAgentHeartbeatAction = async () => {};

function agent(status: string): Record<string, unknown> {
  return {
    id: `agent-${status}`,
    companyId: 'company-a',
    urlKey: `a-${status}`,
    name: 'Fixture agent',
    title: 'Fixture',
    role: 'engineer',
    status,
    adapterType: 'lmstudio',
    modelId: 'model-1',
    providerId: null,
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } },
    budgetMonthlyTokens: 0,
    spentMonthlyTokens: 0,
  };
}

describe('#119 soft: agents list row active toggle', () => {
  let AgentListRow: (p: Record<string, unknown>) => React.ReactNode;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (this.filename?.endsWith('agent-list-row.tsx')) {
        if (id === './actions') return { toggleAgentActiveAction, triggerAgentHeartbeatAction };
        if (id === 'next/link') {
          return {
            __esModule: true,
            default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
              React.createElement('a', { href, ...rest }, children),
          };
        }
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ AgentListRow } = (await import('./agent-list-row')) as never);
    Module.prototype.require = originalRequire;
  });

  const render = (status: string) =>
    renderToStaticMarkup(React.createElement(AgentListRow, { agent: agent(status), providers: [] }));
  // The toggle is the form carrying the hidden `active` field.
  const hasToggle = (html: string) => /<input[^>]*name="active"/.test(html);

  it('archived agent: no active toggle, read-only "archived" badge instead', () => {
    const html = render('archived');
    assert.equal(hasToggle(html), false);
    assert.doesNotMatch(html, />(Active|Inactive)<\/button>/);
    assert.match(html, />archived</);
  });

  it('pending_approval agent: no active toggle either', () => {
    assert.equal(hasToggle(render('pending_approval')), false);
  });

  it('controls: active and paused agents keep the toggle with the right next value', () => {
    const active = render('active');
    assert.ok(hasToggle(active));
    assert.match(active, /<input[^>]*name="active"[^>]*value="false"/);
    assert.match(active, />Active<\/button>/);
    const paused = render('paused');
    assert.ok(hasToggle(paused));
    assert.match(paused, /<input[^>]*name="active"[^>]*value="true"/);
    assert.match(paused, />Inactive<\/button>/);
  });
});
