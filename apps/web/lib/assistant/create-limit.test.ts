/** UI-2: per-company sliding-window limit on new assistant threads. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_THREAD_CREATE_LIMIT as LIMIT,
  ASSISTANT_THREAD_CREATE_WINDOW_MS as WINDOW,
  resetThreadCreateLimitForTests,
  takeThreadCreateSlot,
} from './create-limit';

describe('UI-2 thread creation limit', () => {
  beforeEach(() => resetThreadCreateLimitForTests());

  it('allows LIMIT per window per company, then reports when a slot frees up', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LIMIT; i++) assert.deepEqual(takeThreadCreateSlot('c1', t0 + i), { ok: true });
    assert.deepEqual(takeThreadCreateSlot('c1', t0 + 1000), { ok: false, retryAfterSec: 59 });
    assert.deepEqual(takeThreadCreateSlot('c2', t0 + 1000), { ok: true }, 'other companies have their own window');
    assert.deepEqual(takeThreadCreateSlot('c1', t0 + WINDOW), { ok: true }, 'the oldest slot expired');
    assert.equal(takeThreadCreateSlot('c1', t0 + WINDOW).ok, false);
  });

  it('a refused attempt does not extend the window', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < LIMIT; i++) takeThreadCreateSlot('c1', t0);
    for (let i = 0; i < 100; i++) assert.equal(takeThreadCreateSlot('c1', t0 + 10).ok, false);
    assert.equal(takeThreadCreateSlot('c1', t0 + WINDOW + 1).ok, true);
  });
});
