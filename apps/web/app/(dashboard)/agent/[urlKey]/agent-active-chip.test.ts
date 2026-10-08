/**
 * UX-2: Active/Inactive chip on the agent detail page.
 * No DOM test library in the repo: the optimistic/rollback/confirm logic is tested as plain
 * functions (agent-active-chip-logic.ts), and the chip's markup via react-dom/server with
 * ../actions, next/navigation and sonner mocked.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  agentChipActionLabel,
  agentChipLabel,
  canToggleAgentChip,
  isAgentChipActive,
  runOptimisticAgentToggle,
  shouldConfirmAgentToggle,
  type AgentActiveToggleResult,
} from './agent-active-chip-logic';

function harness(result: AgentActiveToggleResult | Error) {
  const applied: boolean[] = [];
  const errors: string[] = [];
  const calls: boolean[] = [];
  return {
    applied,
    errors,
    calls,
    opts: (current: boolean, next: boolean) => ({
      current,
      next,
      apply: (v: boolean) => applied.push(v),
      call: async (v: boolean) => {
        calls.push(v);
        if (result instanceof Error) throw result;
        return result;
      },
      onError: (m: string) => errors.push(m),
    }),
  };
}

describe('UX-2 chip logic', () => {
  it('Active → Inactive: optimistic, then settles on the server value', async () => {
    const h = harness({ ok: true, active: false, status: 'paused' });
    assert.equal(await runOptimisticAgentToggle(h.opts(true, false)), true);
    assert.deepEqual(h.calls, [false]);
    assert.deepEqual(h.applied, [false, false]);
    assert.deepEqual(h.errors, []);
  });

  it('Inactive → Active', async () => {
    const h = harness({ ok: true, active: true, status: 'active' });
    assert.equal(await runOptimisticAgentToggle(h.opts(false, true)), true);
    assert.deepEqual(h.calls, [true]);
    assert.deepEqual(h.applied, [true, true]);
  });

  it('server error → rolls back and reports the message (toast)', async () => {
    const h = harness({ ok: false, status: 500, error: 'Failed to update agent status.' });
    assert.equal(await runOptimisticAgentToggle(h.opts(true, false)), false);
    assert.deepEqual(h.applied, [false, true], 'optimistic false, then rollback to true');
    assert.deepEqual(h.errors, ['Failed to update agent status.']);
  });

  it('thrown call (network, or board session refused) → rolls back with the generic message', async () => {
    const h = harness(new Error('Board session required.'));
    assert.equal(await runOptimisticAgentToggle(h.opts(false, true)), false);
    assert.deepEqual(h.applied, [true, false]);
    assert.deepEqual(h.errors, ['Failed to update agent status.']);
  });

  it('confirm only when deactivating with a running heartbeat', () => {
    assert.equal(shouldConfirmAgentToggle(true, { id: 'r1', status: 'running' }), true);
    assert.equal(shouldConfirmAgentToggle(true, { id: 'r1', status: 'queued' }), false);
    assert.equal(shouldConfirmAgentToggle(true, null), false);
    assert.equal(shouldConfirmAgentToggle(false, { id: 'r1', status: 'running' }), false, 'activating never confirms');
    assert.equal(shouldConfirmAgentToggle(false, null), false);
  });

  it('chip state comes from agents.status only; archived/pending keep the read-only badge', () => {
    assert.equal(isAgentChipActive('active'), true);
    assert.equal(isAgentChipActive('paused'), false);
    assert.equal(agentChipLabel(true), 'Active');
    assert.equal(agentChipLabel(false), 'Inactive');
    assert.equal(agentChipActionLabel(true), 'Deactivate agent');
    assert.equal(agentChipActionLabel(false), 'Activate agent');
    assert.equal(canToggleAgentChip('active'), true);
    assert.equal(canToggleAgentChip('paused'), true);
    assert.equal(canToggleAgentChip('archived'), false);
    assert.equal(canToggleAgentChip('pending_approval'), false);
  });
});

describe('UX-2 chip markup', () => {
  let AgentActiveChip: (p: Record<string, unknown>) => React.ReactNode;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (this.filename?.endsWith('agent-active-chip.tsx')) {
        if (id === '../actions') return { setAgentActiveAction: async () => ({ ok: true, active: true, status: 'active' }) };
        if (id === 'next/navigation') return { useRouter: () => ({ refresh: () => {} }) };
        if (id === 'sonner') return { toast: { error: () => {} } };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ AgentActiveChip } = (await import('./agent-active-chip')) as never);
  });

  const render = (initialStatus: string, inFlightHeartbeat: unknown = null) =>
    renderToStaticMarkup(
      React.createElement(AgentActiveChip, { agentId: 'a1', urlKey: 'a', initialStatus, inFlightHeartbeat }),
    );

  it('active agent: "Active" button (type=button) whose accessible name is the action, "Deactivate agent"', () => {
    const html = render('active');
    assert.match(html, /<button[^>]*type="button"[^>]*aria-label="Deactivate agent"[^>]*>Active<\/button>/);
    assert.doesNotMatch(html, /aria-pressed/);
  });

  it('paused agent: "Inactive" button named "Activate agent"; the confirm dialog is closed by default', () => {
    const html = render('paused', { id: 'r1', status: 'running' });
    assert.match(html, /<button[^>]*aria-label="Activate agent"[^>]*>Inactive<\/button>/);
    assert.doesNotMatch(html, /aria-pressed/);
    assert.doesNotMatch(html, /Make this agent inactive\?/);
  });
});
