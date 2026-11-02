/**
 * S295-S3 (#295 soft): the run-status badge for `skipped` must be neutral.
 *
 * StatusBadge renders heartbeat run status on /jobs/heartbeat
 * (heartbeat-list-client) and /jobs/heartbeat/[jobId] (job-detail-live). `skipped`
 * had no table entry; the pin below demands an explicit neutral mapping ('ghost',
 * the same muted family as paused/expired/archived) — NOT an accident of the
 * `?? 'outline'` fallback, and never the destructive (error) colour.
 *
 * Mutant (S295-S3 gate M6): remove `skipped: 'ghost'` from STATUS_VARIANTS →
 * statusBadgeVariant('skipped') falls back to 'outline' → RED. Siblings keep the
 * table honest (failed must stay destructive).
 *
 * statusBadgeVariant is the table lookup extracted from StatusBadge so this is
 * pinned without rendering React.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusBadgeVariant } from './status-badges';

describe('statusBadgeVariant: skipped renders neutral, never error (S295-S3, #295)', () => {
  it('skipped maps to an explicit neutral variant', () => {
    const variant = statusBadgeVariant('skipped');
    assert.equal(variant, 'ghost', 'skipped needs a deliberate table entry, not the fallback');
    assert.notEqual(variant, 'destructive', 'a skipped wake is not an error');
  });

  it('normalisation applies to skipped too (case/space tolerant)', () => {
    assert.equal(statusBadgeVariant('Skipped'), 'ghost');
    assert.equal(statusBadgeVariant('  skipped  '.trim().toUpperCase()), 'ghost');
  });

  it('sibling run statuses keep their meanings', () => {
    assert.equal(statusBadgeVariant('failed'), 'destructive');
    assert.equal(statusBadgeVariant('succeeded'), 'default');
    assert.equal(statusBadgeVariant('running'), 'secondary');
    assert.equal(statusBadgeVariant('queued'), 'outline');
    assert.equal(statusBadgeVariant('cancelled'), 'outline');
    assert.equal(statusBadgeVariant('brand-new-status'), 'outline', 'unknown → neutral fallback');
  });
});
