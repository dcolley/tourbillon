/**
 * TB-364 (H): the server-side failure-marker layer — classification (A19/A20), marker write and
 * read-back through the same-id user-row upsert (A2/A23 incl. attempts across reloads), the
 * append-only marker row when the user row does not exist yet (A2 race), the queue waiting row
 * (A28: text ONLY in attributes, never model context — M16), the discard rewrite (A35c/M50) and
 * the discarded-key refusal check (A32e). Plus the redactor (A26): secrets never survive, the
 * output is bounded, and a 1 MB hostile string is processed well under 200 ms.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRunFailure,
  findUserRowForKey,
  persistRunOutcomeMarker,
  persistQueueMarkerRow,
  persistDiscardMarker,
  isKeyDiscarded,
  readTb364Attrs,
  tb364Attrs,
  DISCARDED_PLACEHOLDER_TEXT,
  TB364_QUEUE_TAG,
  TB364_MARKER_TAG,
  type MarkerSessionLike,
  type MarkerWritableRow,
} from './failure-marker';
import { redactErrorText, TECHNICAL_MAX_CHARS } from './redact-error';

/** Fake Mastra session: rows in an array; sendSignalToThread upserts by id (same-id wins). */
function fakeSession(rows: MarkerWritableRow[] = []): MarkerSessionLike & { rows: MarkerWritableRow[]; sent: unknown[] } {
  const sent: unknown[] = [];
  const session = {
    rows,
    sent,
    thread: {
      async listMessages({ threadId: _t, limit: _l }: { threadId: string; limit?: number }) {
        return rows.map((r) => structuredClone(r));
      },
    },
    sendSignalToThread(signal: {
      id: string;
      type: 'user' | 'notification';
      tagName: string;
      contents: unknown;
      attributes?: Record<string, unknown>;
    }) {
      sent.push(signal);
      const next: MarkerWritableRow = {
        id: signal.id,
        content: {
          parts: Array.isArray(signal.contents) ? signal.contents : [],
          metadata: { signal: { tagName: signal.tagName, attributes: signal.attributes } },
        },
      };
      const at = rows.findIndex((r) => r.id === signal.id);
      if (at >= 0) rows[at] = { ...rows[at], ...next };
      else rows.push(next);
      return { accepted: Promise.resolve({ accepted: true }) };
    },
  } as unknown as MarkerSessionLike & { rows: MarkerWritableRow[]; sent: unknown[] };
  return session;
}

const userRow = (id: string, text: string): MarkerWritableRow => ({
  id,
  role: 'user',
  content: { parts: [{ type: 'text', text }] },
});

const RUN = { resourceId: 'res-1', threadId: 'thr-1' };
const NEW_ID = (() => {
  let n = 0;
  return () => `tb364-gen-${++n}`;
})();

describe('TB-364 classifyRunFailure (A19/A20)', () => {
  it('5xx text is retryable server_error; side effects bar automatic retry', () => {
    const plain = classifyRunFailure({ engineText: 'upstream 500 internal error' });
    assert.equal(plain.retryable, true);
    assert.equal(plain.category, 'server_error');
    const streamed = classifyRunFailure({ engineText: 'upstream 500 internal error', streamedText: true });
    assert.equal(streamed.retryable, false, 'A20: streamed text bars automatic retry');
    assert.equal(streamed.partial, true);
    const tool = classifyRunFailure({ engineText: 'boom', toolStarted: true });
    assert.equal(tool.toolRan, true);
    assert.equal(tool.retryable, false, 'A20 (PM Q7): a tool ran — automatic retry barred');
    const unknown = classifyRunFailure({ engineText: 'totally unexpected condition xyzzy' });
    assert.equal(unknown.retryable, false, 'unknown is permanent');
  });
  it('technical is redacted before it is stored (A26)', () => {
    const f = classifyRunFailure({ engineText: 'failed with key sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' });
    assert.ok(!f.technical.includes('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'), 'secret must not survive');
    assert.ok(f.technical.includes('redacted'), 'redaction placeholder present');
  });
});

describe('TB-364 marker persistence (A2/A23/A28/A35/A32e)', () => {
  it('attrs round-trip through the string bag', () => {
    const fields = {
      clientMessageId: 'cmid-364-aaaa',
      state: 'failed' as const,
      category: 'rate_limited',
      retryable: true,
      attempts: 2,
      technical: 'upstream 429',
      retryAfterMs: 15000,
      partial: true,
    };
    assert.deepEqual(readTb364Attrs(tb364Attrs(fields)), fields);
  });

  it('failed run writes the marker on the STORED USER ROW (same id) and increments attempts across reloads', async () => {
    const s = fakeSession([userRow('m1', 'do the thing')]);
    const failure = classifyRunFailure({ engineText: 'upstream 500 internal server error' });
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-aaaa', text: 'do the thing', ok: false, failure, newId: NEW_ID });
    let marker = readTb364Attrs((s.rows[0]!.content!.metadata as { signal: { attributes: unknown } }).signal.attributes)!;
    assert.equal(marker.state, 'failed', 'wrote onto the stored row');
    assert.equal(marker.attempts, 1);
    assert.equal(marker.clientMessageId, 'cmid-364-aaaa');
    // second attempt ("reload" simulated by a fresh read of the same stored truth)
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-aaaa', text: 'do the thing', ok: false, failure, newId: NEW_ID });
    marker = readTb364Attrs((s.rows[0]!.content!.metadata as { signal: { attributes: unknown } }).signal.attributes)!;
    assert.equal(marker.attempts, 2, 'A23: attempt count lives on the row, not in the client');
    assert.equal(s.rows.filter((r) => r.id === 'm1').length, 1, 'same-id upsert — no duplicate row');
  });

  it('a successful retry CLEARS the failure (state sent)', async () => {
    const s = fakeSession([userRow('m1', 'hi')]);
    const failure = classifyRunFailure({ engineText: 'upstream 500' });
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-bbbb', text: 'hi', ok: false, failure, newId: NEW_ID });
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-bbbb', text: 'hi', ok: true, newId: NEW_ID });
    const marker = readTb364Attrs((s.rows[0]!.content!.metadata as { signal: { attributes: unknown } }).signal.attributes)!;
    assert.equal(marker.state, 'sent');
    assert.equal(marker.technical, undefined);
  });

  it('no stored user row yet → the marker is APPENDED as its own tb364-marker row (A2 race)', async () => {
    const s = fakeSession([]);
    const failure = classifyRunFailure({ engineText: 'connection reset by peer' });
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-cccc', text: 'never stored', ok: false, failure, newId: NEW_ID });
    assert.equal(s.rows.length, 1, 'marker row appended instead');
    assert.equal((s.rows[0]!.content!.metadata as { signal: { tagName: string } }).signal.tagName, TB364_MARKER_TAG);
    const bag = (s.rows[0]!.content!.metadata as { signal: { attributes: unknown } }).signal.attributes;
    const marker = readTb364Attrs(bag)!;
    assert.equal(marker.state, 'failed');
    assert.equal(marker.clientMessageId, 'cmid-364-cccc');
  });

  it('queue row: waiting state, text ONLY in attributes, never in parts (A28/M16)', async () => {
    const s = fakeSession([]);
    await persistQueueMarkerRow(s, { ...RUN, clientMessageId: 'cmid-364-dddd', text: 'SECOND message secret', newId: NEW_ID });
    const row = s.rows[0]!;
    const parts = row.content!.parts as { type: string; text: string }[];
    assert.equal(parts[0]!.text, '', 'parts carry NO text — waiting messages must not reach the model');
    const marker = readTb364Attrs((row.content!.metadata as { signal: { attributes: unknown } }).signal.attributes)!;
    assert.equal(marker.state, 'waiting');
    assert.equal(marker.text, 'SECOND message secret');
    // idempotent: a second accept of the same key does not double-store
    await persistQueueMarkerRow(s, { ...RUN, clientMessageId: 'cmid-364-dddd', text: 'SECOND message secret', newId: NEW_ID });
    assert.equal(s.rows.length, 1);
  });

  it('discard: user row text → placeholder, original kept in the marker; isKeyDiscarded blocks replay (A35c/A32e)', async () => {
    const s = fakeSession([userRow('m1', 'sensitive original text')]);
    const failure = classifyRunFailure({ engineText: 'upstream 500' });
    await persistRunOutcomeMarker(s, { ...RUN, clientMessageId: 'cmid-364-eeee', text: 'sensitive original text', ok: false, failure, newId: NEW_ID });
    const ok = await persistDiscardMarker(s, { ...RUN, clientMessageId: 'cmid-364-eeee', newId: NEW_ID });
    assert.equal(ok, true);
    const row = s.rows[0]!;
    const parts = row.content!.parts as { type: string; text: string }[];
    assert.equal(parts[0]!.text, DISCARDED_PLACEHOLDER_TEXT, 'stored text replaced (context exclusion, M50)');
    const marker = readTb364Attrs((row.content!.metadata as { signal: { attributes: unknown } }).signal.attributes)!;
    assert.equal(marker.state, 'discarded');
    assert.equal(marker.text, 'sensitive original text', 'original survives for the transcript');
    assert.equal(await isKeyDiscarded(s, RUN.threadId, 'cmid-364-eeee'), true);
    assert.equal(await isKeyDiscarded(s, RUN.threadId, 'cmid-unknown'), false);
  });

  it('discard of an unknown key returns false (endpoint 404)', async () => {
    const s = fakeSession([userRow('m1', 'unrelated')]);
    assert.equal(await persistDiscardMarker(s, { ...RUN, clientMessageId: 'cmid-nope', newId: NEW_ID }), false);
  });

  it('findUserRowForKey matches by key first, text second', async () => {
    const s = fakeSession([userRow('m1', 'dup text'), userRow('m2', 'dup text')]);
    const byText = await findUserRowForKey(s, RUN.threadId, 'cmid-new', 'dup text');
    assert.equal(byText?.id, 'm1', 'oldest text match wins');
  });
});

describe('TB-364 redactor (A26)', () => {
  it('secrets are stripped; internal addresses soft-redacted; model-group names survive', () => {
    const out = redactErrorText(
      'Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 at 192.168.10.5 api_key=supersecretvalue123 model inkling-2-mini',
    );
    assert.ok(!out.includes('sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'));
    assert.ok(!out.includes('supersecretvalue123'));
    assert.ok(!out.includes('192.168.10.5'), 'RFC1918 address must be soft-redacted');
    assert.ok(out.includes('inkling-2-mini'), 'model-group names are allowed (PM ruling)');
  });
  it('bounded output with a visible truncation marker', () => {
    const out = redactErrorText('y'.repeat(TECHNICAL_MAX_CHARS * 3));
    assert.ok(out.length <= TECHNICAL_MAX_CHARS + 64, 'bounded');
    assert.match(out, /truncat/i);
  });
  it('1 MB hostile input processes in well under 200 ms (linear patterns)', () => {
    const hostile = 'a'.repeat(500_000) + ' sk-live-' + 'A'.repeat(60) + ' ' + 'http://user:***@10.1.2.3/' + '?'.repeat(499_000);
    const t0 = performance.now();
    const out = redactErrorText(hostile);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `redaction took ${ms.toFixed(1)} ms for 1 MB`);
    assert.ok(!out.includes('user:***@'));
    void TB364_QUEUE_TAG;
    void TB364_MARKER_TAG;
  });
});
