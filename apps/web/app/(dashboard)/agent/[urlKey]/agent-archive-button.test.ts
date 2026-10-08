/**
 * Board 'Archive agent' confirm dialog: the counts line and the permanent (no unarchive) copy.
 * Markup via react-dom/server with ../archive-action, next/navigation and sonner mocked (no DOM
 * test library in the repo). The dialog itself is closed on first render, so the counts line is
 * rendered through ArchiveImpactSummary, the component the open dialog shows.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { archiveImpactText, archiveResultText, ARCHIVE_PERMANENT_COPY } from '../../../../lib/agent-archive-copy';

describe('Archive agent dialog copy', () => {
  it("counts line: 'N pending approvals will be rejected, M open issues unassigned' (singular/plural)", () => {
    assert.equal(
      archiveImpactText({ pendingApprovals: 2, openIssues: 3 }),
      '2 pending approvals will be rejected, 3 open issues unassigned',
    );
    assert.equal(
      archiveImpactText({ pendingApprovals: 1, openIssues: 1 }),
      '1 pending approval will be rejected, 1 open issue unassigned',
    );
    assert.equal(
      archiveImpactText({ pendingApprovals: 0, openIssues: 0 }),
      '0 pending approvals will be rejected, 0 open issues unassigned',
    );
    assert.equal(
      archiveResultText({ approvalsRejected: 2, issuesUnassigned: 1 }),
      '2 pending approvals rejected, 1 open issue unassigned',
    );
  });

  it('permanent: the copy says there is no unarchive', () => {
    assert.match(ARCHIVE_PERMANENT_COPY, /permanent/);
    assert.match(ARCHIVE_PERMANENT_COPY, /can't be unarchived/);
  });
});

describe('Archive agent dialog markup', () => {
  type Mod = typeof import('./agent-archive-button');
  let ArchiveImpactSummary: Mod['ArchiveImpactSummary'];
  let AgentArchiveButton: Mod['AgentArchiveButton'];
  let createLatestRequestGate: Mod['createLatestRequestGate'];

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (this.filename?.endsWith('agent-archive-button.tsx')) {
        if (id === '../archive-action') {
          return {
            archiveAgentAction: async () => ({ ok: false, status: 500, error: 'not in this test' }),
            getArchiveImpactAction: async () => ({ ok: true, archived: false, pendingApprovals: 2, openIssues: 3 }),
          };
        }
        if (id === 'next/navigation') return { useRouter: () => ({ refresh: () => {} }) };
        if (id === 'sonner') return { toast: { error: () => {}, success: () => {} } };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ ArchiveImpactSummary, AgentArchiveButton, createLatestRequestGate } = await import('./agent-archive-button'));
  });

  it('the open dialog shows the counts before confirming', () => {
    const html = renderToStaticMarkup(
      React.createElement(ArchiveImpactSummary, { impact: { state: 'ready', pendingApprovals: 2, openIssues: 3 } }),
    );
    assert.match(html, /2 pending approvals will be rejected, 3 open issues unassigned\./);
  });

  it('while counting, or if counting failed, no counts are shown', () => {
    const loading = renderToStaticMarkup(React.createElement(ArchiveImpactSummary, { impact: { state: 'loading' } }));
    assert.match(loading, /Checking pending approvals and open issues/);
    const failed = renderToStaticMarkup(
      React.createElement(ArchiveImpactSummary, { impact: { state: 'error', error: 'Agent not found.' } }),
    );
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Agent not found\./);
    assert.doesNotMatch(failed, /will be rejected/);
  });

  it('button copy says archiving is permanent with no unarchive; an archived agent gets a note instead', () => {
    const active = renderToStaticMarkup(
      React.createElement(AgentArchiveButton, { agentId: 'a1', agentName: 'Worker', urlKey: 'worker', status: 'active' }),
    );
    assert.match(active, /Archiving is permanent: there is no unarchive\./);
    assert.match(active, /rejects its pending approvals and\s+unassigns its open issues/);
    assert.match(active, /<button[^>]*type="button"[^>]*>Archive agent<\/button>/);
    const archived = renderToStaticMarkup(
      React.createElement(AgentArchiveButton, { agentId: 'a1', agentName: 'Worker', urlKey: 'worker', status: 'archived' }),
    );
    assert.match(archived, /can&#x27;t be unarchived or reactivated/);
    assert.doesNotMatch(archived, /<button/);
  });

  it('the dialog loads the counts when it opens and keeps confirm disabled until they are shown', async () => {
    const source = await readFile(path.join(__dirname, 'agent-archive-button.tsx'), 'utf-8');
    assert.match(source, /async function openDialog\(\)[\s\S]*getArchiveImpactAction\(agentId\)/);
    assert.match(source, /<ArchiveImpactSummary impact=\{impact\} \/>/);
    assert.match(source, /disabled=\{pending \|\| impact\.state !== 'ready'\}/);
  });

  it('reopened quickly: only the latest open sets the counts (a slow earlier fetch is ignored)', async () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    gate.cancel(); // closed
    const second = gate.begin(); // reopened
    assert.equal(gate.isLatest(first), false);
    assert.equal(gate.isLatest(second), true);
    gate.cancel(); // closed again: nothing in flight may set the counts
    assert.equal(gate.isLatest(second), false);
    // Two opens without a close in between: the later one wins.
    const a = gate.begin();
    const b = gate.begin();
    assert.deepEqual([gate.isLatest(a), gate.isLatest(b)], [false, true]);
    // The dialog checks the gate before setting the counts, on success and on failure, and every
    // close goes through closeDialog (which cancels the gate).
    const source = await readFile(path.join(__dirname, 'agent-archive-button.tsx'), 'utf-8');
    assert.match(source, /const request = impactGate\.begin\(\);[\s\S]*getArchiveImpactAction\(agentId\);\s*if \(!impactGate\.isLatest\(request\)\) return;\s*setImpact\(/);
    assert.match(source, /catch \{\s*if \(!impactGate\.isLatest\(request\)\) return;/);
    assert.match(source, /function closeDialog\(\) \{\s*impactGate\.cancel\(\);\s*setOpen\(false\);/);
    assert.doesNotMatch(source, /setOpen\(false\)[\s\S]*setOpen\(false\)/);
  });
});
