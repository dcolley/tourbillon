/**
 * CHAT-PAGE-1: transcript paging rules (query params, slicing a window of the newest messages).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_TRANSCRIPT_MAX_PAGE_SIZE,
  ASSISTANT_TRANSCRIPT_PAGE_SIZE,
  initialTranscriptWindow,
  parseTranscriptPageQuery,
  sliceTranscriptPage,
} from './transcript-page';

const q = (s: string) => parseTranscriptPageQuery(new URLSearchParams(s));
const msgs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }));
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('parseTranscriptPageQuery', () => {
  it('no paging params → the whole transcript (back-compat)', () => {
    assert.deepEqual(q(''), { ok: true, query: null });
    assert.deepEqual(q('sessionScope=x'), { ok: true, query: null });
  });
  it('limit and before', () => {
    assert.equal(ASSISTANT_TRANSCRIPT_PAGE_SIZE, 20);
    assert.deepEqual(q('limit=20'), { ok: true, query: { limit: 20, before: null } });
    assert.deepEqual(q('limit=5&before=abc-1'), { ok: true, query: { limit: 5, before: 'abc-1' } });
    assert.deepEqual(q('before=abc'), { ok: true, query: { limit: 20, before: 'abc' } }, 'default page size');
    assert.deepEqual(q(`limit=${ASSISTANT_TRANSCRIPT_MAX_PAGE_SIZE}`), { ok: true, query: { limit: 100, before: null } });
  });
  it('rejects bad values', () => {
    for (const bad of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'limit=101', 'limit=99999', 'before=', 'before=%20', `before=${'x'.repeat(201)}`, 'before=a%00b']) {
      assert.equal(q(bad).ok, false, bad);
    }
  });
});

describe('sliceTranscriptPage', () => {
  it('newest page: the last `limit`, hasMore from the extra row', () => {
    const r = sliceTranscriptPage(msgs(21), { limit: 20, before: null, exhausted: false });
    assert.equal(r.complete, true);
    assert.deepEqual(ids(r.messages), ids(msgs(20, 2)));
    assert.equal(r.hasMore, true);
  });
  it('newest page of a short thread: everything, no more', () => {
    const r = sliceTranscriptPage(msgs(3), { limit: 20, before: null, exhausted: true });
    assert.deepEqual(r, { complete: true, found: true, messages: msgs(3), hasMore: false });
  });
  it('exactly `limit` messages: whole thread, no more', () => {
    const r = sliceTranscriptPage(msgs(20), { limit: 20, before: null, exhausted: true });
    assert.equal(r.messages.length, 20);
    assert.equal(r.hasMore, false);
  });
  it('before: the `limit` strictly older than the cursor', () => {
    const r = sliceTranscriptPage(msgs(50), { limit: 20, before: 'm41', exhausted: true });
    assert.deepEqual(ids(r.messages), ids(msgs(20, 21)));
    assert.equal(r.hasMore, true);
  });
  it('before near the start: the rest, no more', () => {
    const r = sliceTranscriptPage(msgs(50), { limit: 20, before: 'm6', exhausted: true });
    assert.deepEqual(ids(r.messages), ids(msgs(5)));
    assert.equal(r.hasMore, false);
  });
  it('window too small (cursor missing or page reaches the window start): incomplete → widen', () => {
    assert.equal(sliceTranscriptPage(msgs(41, 60), { limit: 20, before: 'm5', exhausted: false }).complete, false);
    assert.equal(sliceTranscriptPage(msgs(41, 60), { limit: 20, before: 'm70', exhausted: false }).complete, false);
  });
  it('cursor not in the thread at all: complete, not found', () => {
    const r = sliceTranscriptPage(msgs(10), { limit: 20, before: 'zzz', exhausted: true });
    assert.deepEqual(r, { complete: true, found: false, messages: [], hasMore: false });
  });
  it('first window sizes', () => {
    assert.equal(initialTranscriptWindow({ limit: 20, before: null }), 21);
    assert.equal(initialTranscriptWindow({ limit: 20, before: 'x' }), 41);
    assert.equal(initialTranscriptWindow({ limit: 5, before: 'x' }), 41);
  });
});
