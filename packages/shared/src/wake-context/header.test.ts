import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveStateHeader, LIVE_STATE_TRUST_TEXT } from './header';
import type { WakeApprovalRef, WakeLiveContext } from './types';

const AS_OF = '2026-10-08T07:38:21.950Z';
const appr = (id: string, over: Partial<WakeApprovalRef> = {}): WakeApprovalRef => ({
  id: `${id}-0000-4000-8000-000000000000`,
  status: 'approved',
  decidedAt: '2026-10-08T07:35:00.000Z',
  createdAt: '2026-10-07T10:00:00.000Z',
  note: `Decision for ${id}.`,
  title: null,
  linked: false,
  ...over,
});

function ctx(over: Partial<WakeLiveContext> = {}): WakeLiveContext {
  return {
    version: 1,
    asOf: AS_OF,
    agent: { id: 'agent-1', name: 'Cyber', urlKey: 'cyber' },
    task: {
      id: 'task-1', identifier: 'TOUR-1', title: 'Fix the thing', status: 'in_review', priority: 'high',
      assignee: { kind: 'self', name: 'Cyber' },
    },
    parent: { identifier: 'TOUR-2', status: 'cancelled' },
    blockers: [{ identifier: 'TOUR-3', status: 'blocked' }],
    approvals: [],
    referencedIssues: [],
    lastActivityAt: '2026-10-07T21:04:54.158Z',
    userCommentsSinceLastActivity: 0,
    ...over,
  };
}
const none = new Set<string>();

describe('WC2 live-state header', () => {
  it('first line is authoritative; task, assignee "you (name)", parent and each blocker with status', () => {
    const h = renderLiveStateHeader(ctx(), { citedApprovalIds: none, citedIdentifiers: [] }).text;
    const lines = h.split('\n');
    assert.equal(lines[0], `LIVE STATE (from the database at 07:38Z today; ${LIVE_STATE_TRUST_TEXT})`);
    assert.ok(h.includes('- Task TOUR-1: Fix the thing\n  status in_review, priority high, assignee: you (Cyber)'));
    assert.ok(h.includes('- Parent TOUR-2: cancelled'));
    assert.ok(h.includes('- Blocked by TOUR-3: blocked'));
  });

  it('lists linked approvals and cited approvals; uncited, unlinked ones are left out', () => {
    const c = ctx({
      approvals: [appr('aaaaaaa1', { linked: true }), appr('bbbbbbb2'), appr('ccccccc3')],
    });
    const h = renderLiveStateHeader(c, { citedApprovalIds: new Set(['bbbbbbb2']), citedIdentifiers: [] });
    assert.ok(h.text.includes('- aaaaaaa1 APPROVED 07:35Z: Decision for aaaaaaa1.'));
    assert.ok(h.text.includes('- bbbbbbb2 APPROVED 07:35Z'));
    assert.ok(!h.text.includes('ccccccc3'));
    assert.deepEqual(h.approvalsListed.sort(), ['aaaaaaa1', 'bbbbbbb2']);
  });

  it('sorts pending first, then decided_at desc; max 10 rows then "+N more"; counts pending', () => {
    const approvals = Array.from({ length: 12 }, (_, i) =>
      appr(`d000000${i.toString(16)}`, { linked: true, decidedAt: `2026-10-08T07:${String(10 + i).padStart(2, '0')}:00.000Z` }),
    );
    approvals.push(appr('eeeeeee1', { linked: true, status: 'pending', decidedAt: null, note: null, title: 'Hire a CFO' }));
    const h = renderLiveStateHeader(ctx({ approvals }), { citedApprovalIds: none, citedIdentifiers: [] }).text;
    const rows = h.split('\n').filter((l) => l.startsWith('  - '));
    // #122 follow-up B2: the (agent-written) approval title is not shown in the trusted header.
    assert.equal(rows[0], '  - eeeeeee1 PENDING (filed Oct 7 10:00Z)');
    assert.ok(rows[1].startsWith('  - d000000b APPROVED 07:21Z'));
    assert.ok(rows[2].startsWith('  - d000000a APPROVED 07:20Z'));
    assert.equal(rows.length, 11);
    assert.equal(rows[10], '  - +3 more');
    assert.ok(h.includes('  Pending among these: 1.'));
  });

  it('"Board decisions since your last activity": counts approvals decided after it plus user comments', () => {
    const approvals = [
      appr('a0000001', { linked: true, decidedAt: '2026-10-07T21:00:00.000Z' }), // before last activity
      appr('a0000002', { linked: true, decidedAt: '2026-10-08T07:35:00.000Z' }),
      appr('a0000003', { linked: true, status: 'rejected', decidedAt: '2026-10-08T07:36:00.000Z' }),
    ];
    let h = renderLiveStateHeader(ctx({ approvals }), { citedApprovalIds: none, citedIdentifiers: [] }).text;
    assert.ok(h.includes('- Board decisions since your last activity here (Oct 7 21:04Z): 2 (listed above).'), h);
    h = renderLiveStateHeader(ctx({ approvals, userCommentsSinceLastActivity: 1 }), { citedApprovalIds: none, citedIdentifiers: [] }).text;
    assert.ok(h.includes(': 3 (2 approval decisions listed above, 1 Board/user comment).'), h);
  });

  it('no prior activity, no approvals, no parent or blockers', () => {
    const h = renderLiveStateHeader(
      ctx({ parent: null, blockers: [], lastActivityAt: null, task: { ...ctx().task, assignee: { kind: 'none' } } }),
      { citedApprovalIds: none, citedIdentifiers: [] },
    ).text;
    assert.ok(h.includes('assignee: unassigned'));
    assert.ok(!h.includes('Parent'));
    assert.ok(!h.includes('Blocked by'));
    assert.ok(h.includes('- Approvals referenced on this issue: none'));
    assert.ok(h.includes('- Board decisions since your last activity here (none on record): 0.'));
    assert.ok(!h.includes('Pending among these'));
  });

  it('other issues: resolved cited identifiers only, not task/parent/blocker, max 10', () => {
    const referencedIssues = Array.from({ length: 13 }, (_, i) => ({ identifier: `TOUR-${100 + i}`, status: 'done' }));
    referencedIssues.push({ identifier: 'TOUR-2', status: 'cancelled' });
    const cited = ['TOUR-2', 'TOUR-999', ...referencedIssues.map((r) => r.identifier)];
    const h = renderLiveStateHeader(ctx({ referencedIssues }), { citedApprovalIds: none, citedIdentifiers: cited }).text;
    const line = h.split('\n').find((l) => l.startsWith('- Other issues mentioned:'))!;
    assert.ok(line.startsWith('- Other issues mentioned: TOUR-100 done, TOUR-101 done'));
    assert.ok(line.endsWith(', +3 more'));
    assert.ok(!line.includes('TOUR-999') && !line.includes('TOUR-2 '));
  });

  it('prints a shared Board ruling prefix once and only the remainder per row', () => {
    const ruling = 'Board ruling 8 Oct: descope on evidence; no spend. Close the dependent issues.';
    const approvals = ['f0000001', 'f0000002', 'f0000003'].map((id) =>
      appr(id, { linked: true, note: `${ruling} Decision: option for ${id}.` }),
    );
    const h = renderLiveStateHeader(ctx({ approvals }), { citedApprovalIds: none, citedIdentifiers: [] }).text;
    assert.equal(h.split('Board ruling 8 Oct: descope on evidence').length - 1, 1);
    assert.ok(h.includes(`  Shared Board ruling text on the Oct 8 decisions: "${ruling}"`));
    assert.ok(h.includes('- f0000001 APPROVED 07:35Z: option for f0000001.'));
  });

  it('overflow trims other issues first, then note text, then rows; never over the cap', () => {
    const approvals = Array.from({ length: 10 }, (_, i) =>
      appr(`b000000${i}`, { linked: true, note: `Long note ${i} `.repeat(30) }),
    );
    const referencedIssues = Array.from({ length: 10 }, (_, i) => ({ identifier: `TOUR-${200 + i}`, status: 'in_progress' }));
    const cited = referencedIssues.map((r) => r.identifier);
    const c = ctx({ approvals, referencedIssues });
    const full = renderLiveStateHeader(c, { citedApprovalIds: none, citedIdentifiers: cited, maxChars: 10_000 }).text;
    assert.ok(full.includes('Other issues mentioned'));

    // Just under the full size: other issues go first, notes and rows stay.
    let h = renderLiveStateHeader(c, { citedApprovalIds: none, citedIdentifiers: cited, maxChars: full.length - 20 }).text;
    assert.ok(h.length <= full.length - 20);
    assert.ok(h.includes('Long note 0'));
    assert.equal(h.split('\n').filter((l) => l.startsWith('  - b')).length, 10);

    // Without the issues line it must drop note text next, keeping all 10 rows.
    const noIssues = full.split('\n').filter((l) => !l.startsWith('- Other issues')).join('\n');
    h = renderLiveStateHeader(c, { citedApprovalIds: none, citedIdentifiers: cited, maxChars: noIssues.length - 300 }).text;
    assert.ok(!h.includes('Other issues mentioned'));
    const rows = h.split('\n').filter((l) => l.startsWith('  - b'));
    assert.equal(rows.length, 10);
    for (const r of rows) assert.ok(r.length <= '  - b0000000 APPROVED 07:35Z: '.length + 60, r);

    // Tiny cap: rows go too, still within the cap.
    h = renderLiveStateHeader(c, { citedApprovalIds: none, citedIdentifiers: cited, maxChars: 600 }).text;
    assert.ok(h.length <= 600, String(h.length));
    assert.ok(h.split('\n').filter((l) => l.startsWith('  - b')).length < 10);
    assert.ok(h.startsWith('LIVE STATE'));
  });

  it('default cap 2,400 holds for a very large context', () => {
    const approvals = Array.from({ length: 40 }, (_, i) => appr(`c${String(i).padStart(7, '0')}`, { linked: true, note: 'N '.repeat(300) }));
    const referencedIssues = Array.from({ length: 40 }, (_, i) => ({ identifier: `TOUR-${300 + i}`, status: 'blocked' }));
    const h = renderLiveStateHeader(
      ctx({ approvals, referencedIssues, task: { ...ctx().task, title: 'T'.repeat(3000) } }),
      { citedApprovalIds: none, citedIdentifiers: referencedIssues.map((r) => r.identifier) },
    ).text;
    assert.ok(h.length <= 2400, String(h.length));
  });
});
