/**
 * S295-S3 / S298-S1 (#295, #298): the heartbeat list filter surface must include
 * every terminal status — `skipped`, `coalesced` and `cancelled`.
 *
 * Before #295, `skipped` runs were invisible except under 'all': the stored prefs,
 * the dropdown table, the URL-state mapper and the route-level guard
 * (`isHeartbeatListFilter` in /api/jobs/heartbeat/list) all rejected 'skipped' —
 * S295-S3 pinned their inclusion. S298-S1 (#298) extended the same surface to
 * `coalesced` and `cancelled`, and this file now pins all three (the earlier
 * status-quo pin 'coalesced stays out of scope' is retired). These are the pure
 * read paths — pinned without React or a DB.
 *
 * Mutants (S298-S1 gate M-c1): remove 'coalesced' from the isHeartbeatListFilter
 * table → the route guard degrades filter=coalesced to 'all' → the predicate /
 * URL / persisted-prefs tests go RED; remove it from HEARTBEAT_LIST_FILTERS → the
 * dropdown-table test goes RED. Other filters stay green either way (specificity).
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
  type HeartbeatListFilter,
} from './heartbeat-list-storage';
import type { HeartbeatStatus } from '@tourbillon/db/schema';

describe('heartbeat list filters: skipped/coalesced/cancelled are first-class (S295-S3 + S298-S1)', () => {
  it('HEARTBEAT_LIST_FILTERS offers Skipped, Coalesced and Cancelled alongside the legacy values', () => {
    // Full golden table (labels included) — the dropdown renders exactly this.
    assert.deepEqual(HEARTBEAT_LIST_FILTERS, [
      { value: 'all', label: 'All' },
      { value: 'in_queue', label: 'In queue' },
      { value: 'running', label: 'Running' },
      { value: 'succeeded', label: 'Succeeded' },
      { value: 'failed', label: 'Failed' },
      { value: 'queued', label: 'Queued' },
      { value: 'skipped', label: 'Skipped' },
      { value: 'coalesced', label: 'Coalesced' },
      { value: 'cancelled', label: 'Cancelled' },
    ]);
    // Every table value passes the route guard (table and predicate never drift).
    for (const { value } of HEARTBEAT_LIST_FILTERS) {
      assert.equal(isHeartbeatListFilter(value), true, `table value '${value}' must be accepted`);
    }
  });

  it('isHeartbeatListFilter accepts skipped, coalesced and cancelled; still rejects junk', () => {
    assert.equal(isHeartbeatListFilter('skipped'), true);
    // S298-S1: the retired status-quo pin said coalesced stayed out of scope —
    // terminal statuses are now filterable.
    assert.equal(isHeartbeatListFilter('coalesced'), true);
    assert.equal(isHeartbeatListFilter('cancelled'), true);
    assert.equal(isHeartbeatListFilter('nope'), false);
    assert.equal(isHeartbeatListFilter(''), false);
  });

  it('mapLegacyUrlState round-trips the terminal filters (default branch, not the legacy cases)', () => {
    assert.equal(mapLegacyUrlState('skipped'), 'skipped');
    assert.equal(mapLegacyUrlState('coalesced'), 'coalesced');
    assert.equal(mapLegacyUrlState('cancelled'), 'cancelled');
    // Legacy mappings untouched.
    assert.equal(mapLegacyUrlState('completed'), 'succeeded');
    assert.equal(mapLegacyUrlState('waiting'), 'in_queue');
    assert.equal(mapLegacyUrlState('bogus'), 'all');
  });

  it('parseUrlHeartbeatPrefs honours ?status= for every terminal filter', () => {
    assert.deepEqual(parseUrlHeartbeatPrefs('?status=skipped'), { filter: 'skipped' });
    assert.deepEqual(parseUrlHeartbeatPrefs('?status=coalesced'), { filter: 'coalesced' });
    assert.deepEqual(parseUrlHeartbeatPrefs('?status=cancelled'), { filter: 'cancelled' });
  });

  it('readHeartbeatListPrefs keeps persisted terminal filters (no silent reset to all)', () => {
    for (const filter of ['skipped', 'coalesced', 'cancelled'] as const) {
      const stored = JSON.stringify({
        filter,
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
        assert.equal(prefs.filter, filter, `a stored ${filter} filter must survive validation`);
        assert.equal(prefs.page, 1);
      } finally {
        delete g.window;
        delete g.localStorage;
      }
    }
  });
});

// Compile-time pins (`pnpm -r type-check`): the filter union must admit the
// terminal literals, and every HeartbeatStatus must remain filterable — a status
// added to the DB union without a filter case (or a filter literal removed from
// the union) turns this RED.
const _filterUnionPins: HeartbeatListFilter[] = ['coalesced', 'cancelled'];
const _statusFilterable: Record<HeartbeatStatus, HeartbeatListFilter> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  coalesced: 'coalesced',
  skipped: 'skipped',
};
void _filterUnionPins;
void _statusFilterable;
