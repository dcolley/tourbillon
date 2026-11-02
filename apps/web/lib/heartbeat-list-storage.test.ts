/**
 * S295-S3 (#295 soft): the heartbeat list filter surface must include `skipped`.
 *
 * Before this soft, `skipped` runs were invisible except under 'all': the stored
 * prefs, the dropdown table, the URL-state mapper and the route-level guard
 * (`isHeartbeatListFilter` in /api/jobs/heartbeat/list) all rejected 'skipped'.
 * These are the pure read paths — pinned without React or a DB.
 *
 * Mutants (S295-S3 gate M2): remove 'skipped' from HEARTBEAT_LIST_FILTERS → the
 * dropdown test goes RED; remove it from the isHeartbeatListFilter table → the
 * predicate / URL / persisted-prefs tests go RED. Other filters stay green either
 * way (specificity).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_LIST_FILTERS,
  HEARTBEAT_LIST_STORAGE_KEY,
  isHeartbeatListFilter,
  mapLegacyUrlState,
  parseUrlHeartbeatPrefs,
  readHeartbeatListPrefs,
} from './heartbeat-list-storage';

describe('heartbeat list filters: skipped is a first-class filter (S295-S3, #295)', () => {
  it('HEARTBEAT_LIST_FILTERS offers Skipped alongside the legacy values', () => {
    const skipped = HEARTBEAT_LIST_FILTERS.find((f) => f.value === 'skipped');
    assert.ok(skipped, 'a Skipped option must exist in the filter table');
    assert.equal(skipped!.label, 'Skipped');
    // Legacy options unchanged — Skipped is added, not a rework.
    assert.deepEqual(
      HEARTBEAT_LIST_FILTERS.filter((f) => f.value !== 'skipped').map((f) => f.value),
      ['all', 'in_queue', 'running', 'succeeded', 'failed', 'queued'],
    );
  });

  it('isHeartbeatListFilter accepts skipped and still rejects junk', () => {
    assert.equal(isHeartbeatListFilter('skipped'), true);
    assert.equal(isHeartbeatListFilter('coalesced'), false, 'coalesced stays out of scope');
    assert.equal(isHeartbeatListFilter('nope'), false);
  });

  it('mapLegacyUrlState round-trips skipped (default branch, not the legacy cases)', () => {
    assert.equal(mapLegacyUrlState('skipped'), 'skipped');
    // Legacy mappings untouched.
    assert.equal(mapLegacyUrlState('completed'), 'succeeded');
    assert.equal(mapLegacyUrlState('waiting'), 'in_queue');
    assert.equal(mapLegacyUrlState('bogus'), 'all');
  });

  it('parseUrlHeartbeatPrefs honours ?status=skipped', () => {
    assert.deepEqual(parseUrlHeartbeatPrefs('?status=skipped'), { filter: 'skipped' });
  });

  it('readHeartbeatListPrefs keeps a persisted skipped filter (no silent reset to all)', () => {
    const stored = JSON.stringify({
      filter: 'skipped',
      page: 1,
      pageSize: 25,
      agentUrlKey: null,
      refreshIntervalSec: 0,
    });
    const g = globalThis as { window?: unknown; localStorage?: unknown };
    g.window = {};
    g.localStorage = {
      getItem: (key: string) => (key === HEARTBEAT_LIST_STORAGE_KEY ? stored : null),
    };
    try {
      const prefs = readHeartbeatListPrefs();
      assert.equal(prefs.filter, 'skipped', 'a stored skipped filter must survive validation');
      assert.equal(prefs.page, 1);
    } finally {
      delete g.window;
      delete g.localStorage;
    }
  });
});
