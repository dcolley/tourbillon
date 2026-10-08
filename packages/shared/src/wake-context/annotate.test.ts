import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateClaims, annotateClaimsCounted, extractApprovalTokens, extractIssueIdentifiers, type ApprovalClaimState } from './annotate';

const REF = '2026-10-08T07:38:21.950Z';
const map = new Map<string, ApprovalClaimState>([
  ['23a36ba8', { status: 'rejected', decidedAt: '2026-10-08T07:35:23.155Z' }],
  ['ec9f7589', { status: 'approved', decidedAt: '2026-10-08T07:35:20.312Z' }],
  ['ce9d9f21', { status: 'approved', decidedAt: '2026-10-04T15:56:31.208Z' }],
  ['aaaa0001', { status: 'pending', decidedAt: null }],
]);

describe('WC5 annotateClaims', () => {
  it('spec example: a stale "still pending" claim gets ⟨now REJECTED 07:35Z⟩ after the id', () => {
    assert.equal(
      annotateClaims('approval 23a36ba8 is still pending', map, { refIso: REF }),
      'approval 23a36ba8 ⟨now REJECTED 07:35Z⟩ is still pending',
    );
  });

  it('a pending approval leaves the text unchanged', () => {
    const t = 'approval aaaa0001 is still pending';
    assert.equal(annotateClaims(t, map, { refIso: REF }), t);
  });

  it('decisions on another day carry the date', () => {
    assert.equal(annotateClaims('moratorium ce9d9f21', map, { refIso: REF }), 'moratorium ce9d9f21 ⟨now APPROVED Oct 4 15:56Z⟩');
  });

  it('first mention always; later mentions only near "pending" (25 before / 60 after)', () => {
    const filler = 'x'.repeat(80);
    const text = `23a36ba8 first. ${filler} 23a36ba8 again, nothing to see. ${filler} pending: 23a36ba8. ${filler} 23a36ba8 is pending`;
    const r = annotateClaimsCounted(text, map, { refIso: REF });
    assert.equal(r.count, 3);
    assert.equal((r.text.match(/⟨now REJECTED 07:35Z⟩/g) ?? []).length, 3);
    assert.ok(r.text.includes('23a36ba8 again, nothing'), 'the far mention is untouched');
  });

  it('never rewrites the words around the id', () => {
    const t = 'gates: ec9f7589 (TOUR-543 A/B, still pending) + 23a36ba8.';
    const out = annotateClaims(t, map, { refIso: REF });
    assert.equal(out.replace(/ ⟨now [^⟩]+⟩/g, ''), t);
  });

  it('unknown 8-hex tokens and longer hex runs (commit SHAs) are untouched', () => {
    const t = 're-arm 6ea1e328, commit 23a36ba8c0ffee1234567890abcdef1234567890, sha 23a36ba';
    assert.equal(annotateClaims(t, map, { refIso: REF }), t);
  });

  it('a full UUID is annotated after the UUID, not inside it', () => {
    const t = 'see 23a36ba8-bccc-4114-831b-6fa656e6a2ee now';
    assert.equal(annotateClaims(t, map, { refIso: REF }), 'see 23a36ba8-bccc-4114-831b-6fa656e6a2ee ⟨now REJECTED 07:35Z⟩ now');
  });
});

describe('token extraction', () => {
  it('extracts 8-hex approval tokens and issue identifiers in order, de-duplicated', () => {
    assert.deepEqual(extractApprovalTokens('`686ede6c`/ec9f7589 and 686ede6c, sha 0123456789abcdef'), ['686ede6c', 'ec9f7589']);
    assert.deepEqual(extractIssueIdentifiers('TOUR-542, TOUR-543 then TOUR-542; F-1 N-02 x-TOUR-9'), ['TOUR-542', 'TOUR-543']);
  });
});
