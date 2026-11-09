/**
 * #112: TB112_NOW_MS is a test seam only — ignored when NODE_ENV is production (case-insensitive).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};

describe('#112 oauthNowMs production gate', () => {
  beforeEach(() => {
    for (const k of ['NODE_ENV', 'TB112_NOW_MS', 'BETTER_AUTH_SECRET']) saved[k] = env[k];
    env.BETTER_AUTH_SECRET = 'test-better-auth-secret-112-clock-0123456789';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    // bust module cache so NODE_ENV re-read is not needed — oauthNowMs reads env each call
  });

  it('honours TB112_NOW_MS outside production', async () => {
    try {
      env.NODE_ENV = 'test';
      env.TB112_NOW_MS = '1700000000000';
      const { oauthNowMs } = await import('./vault-oauth-state');
      assert.equal(oauthNowMs(), 1_700_000_000_000);
    } finally {
      // S355-S6: per-writer finally — a failed assert must not leak the frozen clock,
      // even though afterEach restores the snapshot as a second line of defence.
      delete env.TB112_NOW_MS;
    }
  });

  it('ignores TB112_NOW_MS when NODE_ENV=production (exact)', async () => {
    try {
      env.NODE_ENV = 'production';
      env.TB112_NOW_MS = '1700000000000';
      const before = Date.now();
      const { oauthNowMs } = await import('./vault-oauth-state');
      const n = oauthNowMs();
      const after = Date.now();
      assert.ok(n >= before && n <= after + 5, `expected wall clock, got ${n}`);
      assert.notEqual(n, 1_700_000_000_000);
    } finally {
      delete env.TB112_NOW_MS;
    }
  });

  it('ignores TB112_NOW_MS when NODE_ENV=PRODUCTION (case-insensitive)', async () => {
    try {
      env.NODE_ENV = 'PRODUCTION';
      env.TB112_NOW_MS = '1700000000000';
      const before = Date.now();
      const { oauthNowMs } = await import('./vault-oauth-state');
      const n = oauthNowMs();
      const after = Date.now();
      assert.ok(n >= before && n <= after + 5);
      assert.notEqual(n, 1_700_000_000_000);
    } finally {
      delete env.TB112_NOW_MS;
    }
  });
});
