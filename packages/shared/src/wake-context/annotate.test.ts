import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateClaims, annotateClaimsCounted, extractApprovalTokens, extractIssueIdentifiers, type ApprovalClaimState } from './annotate';

const REF = '2026-10-08T07:38:21.950Z';
const map = new Map<string, ApprovalClaimState>([
  ['a0000002', { status: 'rejected', decidedAt: '2026-10-08T07:35:23.155Z' }],
  ['a000000a', { status: 'approved', decidedAt: '2026-10-08T07:35:20.312Z' }],
  ['a0000007', { status: 'approved', decidedAt: '2026-10-04T15:56:31.208Z' }],
  ['aaaa0001', { status: 'pending', decidedAt: null }],
]);

describe('WC5 annotateClaims', () => {
  it('spec example: a stale "still pending" claim gets ⟨now REJECTED 07:35Z⟩ after the id', () => {
    assert.equal(
      annotateClaims('approval a0000002 is still pending', map, { refIso: REF }),
      'approval a0000002 ⟨now REJECTED 07:35Z⟩ is still pending',
    );
  });

  it('a pending approval leaves the text unchanged', () => {
    const t = 'approval aaaa0001 is still pending';
    assert.equal(annotateClaims(t, map, { refIso: REF }), t);
  });

  it('decisions on another day carry the date', () => {
    assert.equal(annotateClaims('moratorium a0000007', map, { refIso: REF }), 'moratorium a0000007 ⟨now APPROVED Oct 4 15:56Z⟩');
  });

  it('first mention always; later mentions only near "pending" (25 before / 60 after)', () => {
    const filler = 'x'.repeat(80);
    const text = `a0000002 first. ${filler} a0000002 again, nothing to see. ${filler} pending: a0000002. ${filler} a0000002 is pending`;
    const r = annotateClaimsCounted(text, map, { refIso: REF });
    assert.equal(r.count, 3);
    assert.equal((r.text.match(/⟨now REJECTED 07:35Z⟩/g) ?? []).length, 3);
    assert.ok(r.text.includes('a0000002 again, nothing'), 'the far mention is untouched');
  });

  it('never rewrites the words around the id', () => {
    const t = 'gates: a000000a (TOUR-543 A/B, still pending) + a0000002.';
    const out = annotateClaims(t, map, { refIso: REF });
    assert.equal(out.replace(/ ⟨now [^⟩]+⟩/g, ''), t);
  });

  it('unknown 8-hex tokens and longer hex runs (commit SHAs) are untouched', () => {
    const t = 're-arm a00000ff, commit a0000002c0ffee1234567890abcdef1234567890, sha a000000';
    assert.equal(annotateClaims(t, map, { refIso: REF }), t);
  });

  it('a full UUID is annotated after the UUID, not inside it', () => {
    const t = 'see a0000002-0000-4000-8000-000000000002 now';
    assert.equal(annotateClaims(t, map, { refIso: REF }), 'see a0000002-0000-4000-8000-000000000002 ⟨now REJECTED 07:35Z⟩ now');
  });
});

describe('token extraction', () => {
  it('extracts 8-hex approval tokens and issue identifiers in order, de-duplicated', () => {
    assert.deepEqual(extractApprovalTokens('`a0000006`/a000000a and a0000006, sha 0123456789abcdef'), ['a0000006', 'a000000a']);
    assert.deepEqual(extractIssueIdentifiers('TOUR-542, TOUR-543 then TOUR-542; F-1 N-02 x-TOUR-9'), ['TOUR-542', 'TOUR-543']);
  });
});
