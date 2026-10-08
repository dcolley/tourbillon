import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNearDuplicate, jaccard, shingles } from './dedupe';
import { renderCommentSectionV2 } from './comments';

const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

describe('WC4 near-duplicate detection', () => {
  it('two bodies that differ by one line give one dedupe marker', () => {
    const shared = Array.from({ length: 12 }, (_, i) => `Line ${i}: ${words(`w${i}x`, 12)}`).join('\n');
    const older = `${shared}\nOlder trailing line only here.`;
    const newer = `${shared}\nNewer trailing line, slightly different.`;
    assert.ok(isNearDuplicate(shingles(older), shingles(newer)));
    const s = renderCommentSectionV2(
      [
        { body: older, authorType: 'agent', authorName: 'Cyber', createdAt: '2026-10-07T21:04:42.492Z' },
        { body: newer, authorType: 'agent', authorName: 'Cyber', createdAt: '2026-10-07T21:04:54.158Z' },
      ],
      { budget: 4500, approvals: new Map(), refIso: '2026-10-08T07:38:21Z', agentName: 'Cyber' },
    );
    assert.equal(s.deduped, 1);
    assert.match(s.text, /Cyber: \(near-duplicate of the newer Cyber 21:04:54Z comment, omitted\)/);
    assert.equal(s.shown, 2);
  });

  it('bodies with similarity ~0.5 are both kept', () => {
    const a = `${words('common', 40)} ${words('onlya', 13)}`;
    const b = `${words('common', 40)} ${words('onlyb', 13)}`;
    const j = jaccard(shingles(a), shingles(b));
    assert.ok(j > 0.4 && j < 0.6, String(j));
    const s = renderCommentSectionV2(
      [
        { body: a, authorType: 'agent', authorName: 'A', createdAt: '2026-10-07T10:00:00Z' },
        { body: b, authorType: 'agent', authorName: 'B', createdAt: '2026-10-07T11:00:00Z' },
      ],
      { budget: 4500, approvals: new Map() },
    );
    assert.equal(s.deduped, 0);
    assert.ok(!s.text.includes('near-duplicate'));
  });
});
