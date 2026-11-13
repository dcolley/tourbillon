/**
 * Bounded best-effort observability flush (safe-flush) — the wake path must survive a
 * collector that rejects (connection refused), hangs, or leaks credentials into error
 * text. Every unit flush converges to a warning; the call itself never rejects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flushUnitsSafely, sanitizeFlushErrorText } from './safe-flush';
import { observabilityFlushTimeoutMs } from './observability';

const env = process.env as Record<string, string | undefined>;

describe('flushUnitsSafely', () => {
  it('resolves and warns when a unit rejects (connection-refused collector)', async () => {
    const warnings: string[] = [];
    await flushUnitsSafely(
      [{ label: 'exporter:arize', flush: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6006')) }],
      { timeoutMs: 1000, warn: (m) => warnings.push(m) },
    );
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0]!, /exporter:arize/);
    assert.match(warnings[0]!, /flush failed/);
    assert.match(warnings[0]!, /ECONNREFUSED/);
  });

  it('flushes sibling exporters even when one rejects (postgres still flushes)', async () => {
    const flushed: string[] = [];
    await flushUnitsSafely(
      [
        { label: 'exporter:arize', flush: () => Promise.reject(new Error('collector down')) },
        { label: 'exporter:postgres', flush: async () => { flushed.push('postgres'); } },
      ],
      { timeoutMs: 1000, warn: () => undefined },
    );
    assert.deepEqual(flushed, ['postgres']);
  });

  it('bounds a hanging collector: resolves after the timeout, late rejection swallowed', async () => {
    const warnings: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectLate: ((err: Error) => void) | undefined;
      const started = Date.now();
      await flushUnitsSafely(
        [{
          label: 'exporter:hang',
          flush: () => new Promise((_res, rej) => { rejectLate = rej; }),
        }],
        { timeoutMs: 50, warn: (m) => warnings.push(m) },
      );
      assert.ok(Date.now() - started < 2000, 'bounded wait, not an open-ended hang');
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.match(warnings[0]!, /timed out/);
      // The abandoned promise rejecting later must not surface as unhandled.
      rejectLate!(new Error('late failure after timeout'));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(unhandled, [], 'timed-out flush rejection must be swallowed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not warn when every unit flushes cleanly', async () => {
    const warnings: string[] = [];
    let n = 0;
    await flushUnitsSafely(
      [{ label: 'a', flush: async () => { n += 1; } }, { label: 'b', flush: async () => { n += 1; } }],
      { timeoutMs: 1000, warn: (m) => warnings.push(m) },
    );
    assert.equal(n, 2);
    assert.deepEqual(warnings, []);
  });

  it('strips URL credentials and caps length in warning text', () => {
    const text = sanitizeFlushErrorText(
      new Error(`failed to reach http://user:hunter2-secret@otel.example.com:4317/v1/traces (${x(500)})`),
    );
    function x(n: number) { return 'a'.repeat(n); }
    assert.ok(!text.includes('hunter2-secret'), text);
    assert.ok(!text.includes('user:hunter2'), text);
    assert.ok(text.includes('[redacted]@'), text);
    assert.ok(text.length <= 301, `capped: ${text.length}`);
  });

  it('sanitizes non-Error throwables without throwing', () => {
    assert.equal(sanitizeFlushErrorText('plain failure'), 'plain failure');
    assert.equal(typeof sanitizeFlushErrorText({ weird: true }), 'string');
  });
});

describe('observabilityFlushTimeoutMs', () => {
  const saved = env.OBSERVABILITY_FLUSH_TIMEOUT_MS;
  try {
    delete env.OBSERVABILITY_FLUSH_TIMEOUT_MS;
    it('defaults to 5000ms', () => {
      assert.equal(observabilityFlushTimeoutMs(), 5000);
    });
    it('honours a positive integer override', () => {
      env.OBSERVABILITY_FLUSH_TIMEOUT_MS = '1500';
      assert.equal(observabilityFlushTimeoutMs(), 1500);
    });
    it('falls back for garbage or non-positive values', () => {
      env.OBSERVABILITY_FLUSH_TIMEOUT_MS = 'nope';
      assert.equal(observabilityFlushTimeoutMs(), 5000);
      env.OBSERVABILITY_FLUSH_TIMEOUT_MS = '0';
      assert.equal(observabilityFlushTimeoutMs(), 5000);
    });
  } finally {
    if (saved === undefined) delete env.OBSERVABILITY_FLUSH_TIMEOUT_MS;
    else env.OBSERVABILITY_FLUSH_TIMEOUT_MS = saved;
  }
});
