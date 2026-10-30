/**
 * #241 softs S241-S2 — heartbeat liveness int32 ceiling.
 *
 * resolveHeartbeatLivenessConfig had floors (fallback on garbage, 2x-ping minimum) but NO
 * CEILING on HEARTBEAT_PING_INTERVAL_SEC / HEARTBEAT_STALE_SEC / HEARTBEAT_PROGRESS_STALE_SEC.
 * All three leave the resolver as `sec * 1000` and are consumed as timer delays: the worker
 * ping via setInterval (wake-runner), the stale watchdog via setTimeout (wake-runner), the
 * harness progress timer via setTimeout (harness-session-drive). Timer delays are int32-
 * signed — above 2^31−1 ms Node resets them to 1 ms — so a huge value meant a 1 ms ping hot
 * loop and an instant-abort watchdog, i.e. the opposite of what the operator configured.
 * Same class as the scheduler poller's #238 S238-S3 clamp.
 *
 * Now: huge finite and +Infinity (a long digit string parses to Infinity) clamp to
 * MAX_HEARTBEAT_INTERVAL_SEC = 2_147_483 (~24.8 days, the largest whole-seconds value whose
 * ×1000 still fits int32). NaN / negatives keep the historic warn-and-fallback floors.
 * The 2x-ping staleSec floor is capped by the same ceiling when pingSec itself sits on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEARTBEAT_PING_INTERVAL_SEC,
  DEFAULT_HEARTBEAT_PROGRESS_STALE_SEC,
  DEFAULT_HEARTBEAT_STALE_SEC,
  MAX_HEARTBEAT_INTERVAL_SEC,
  resolveHeartbeatLivenessConfig,
} from './heartbeat-liveness';

const ENV_KEYS = [
  'HEARTBEAT_PING_INTERVAL_SEC',
  'HEARTBEAT_STALE_SEC',
  'HEARTBEAT_PROGRESS_STALE_SEC',
] as const;

/** Run `body` with the liveness env replaced by `overrides`; restore exactly afterwards. */
function withLivenessEnv(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  body: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const key of ENV_KEYS) {
      const next = overrides[key];
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    }
    body();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('S241-S2: the ceiling constant is the largest whole-seconds value whose ×1000 fits int32', () => {
  assert.equal(MAX_HEARTBEAT_INTERVAL_SEC, 2_147_483);
  assert.equal(MAX_HEARTBEAT_INTERVAL_SEC * 1000, 2_147_483_000);
  assert.ok(
    MAX_HEARTBEAT_INTERVAL_SEC * 1000 < 2 ** 31 - 1,
    'the ceiling in ms must stay under the int32 timer limit (off-by-one guard: +1 second is still safe, +1 ms would not be)',
  );
  assert.ok(
    (MAX_HEARTBEAT_INTERVAL_SEC + 1) * 1000 > 2 ** 31 - 1,
    'one second above the ceiling must overflow int32 — the ceiling is the last safe second',
  );
});

test('S241-S2: huge HEARTBEAT_PING_INTERVAL_SEC clamps to the ceiling, never passes raw to setInterval', () => {
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '3000000000' }, () => {
    const cfg = resolveHeartbeatLivenessConfig();
    assert.equal(cfg.pingIntervalMs, MAX_HEARTBEAT_INTERVAL_SEC * 1000);
    assert.notEqual(cfg.pingIntervalMs, 3_000_000_000, 'the raw 3e9 ms must not survive as-is');
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '2147484' }, () => {
    // The first overflowing second clamps (off-by-one pair with the pass-through below).
    assert.equal(resolveHeartbeatLivenessConfig().pingIntervalMs, MAX_HEARTBEAT_INTERVAL_SEC * 1000);
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '2147483' }, () => {
    // The ceiling itself passes untouched (off-by-one pair with the clamp above).
    assert.equal(resolveHeartbeatLivenessConfig().pingIntervalMs, MAX_HEARTBEAT_INTERVAL_SEC * 1000);
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '9'.repeat(400) }, () => {
    // parseInt on a 400-digit string yields +Infinity — huge, not garbage: the ceiling.
    assert.equal(resolveHeartbeatLivenessConfig().pingIntervalMs, MAX_HEARTBEAT_INTERVAL_SEC * 1000);
  });
});

test('S241-S2: huge HEARTBEAT_STALE_SEC clamps so the watchdog is never an int32-wrapped instant abort', () => {
  withLivenessEnv({ HEARTBEAT_STALE_SEC: '10000000000' }, () => {
    const { staleSec } = resolveHeartbeatLivenessConfig();
    assert.equal(staleSec, MAX_HEARTBEAT_INTERVAL_SEC);
    assert.ok(staleSec * 1000 < 2 ** 31 - 1, 'watchdog delay must fit the int32 timer delay');
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '3000000000', HEARTBEAT_STALE_SEC: '10' }, () => {
    // ping sits on the ceiling → the 2x-ping floor (2 × 2_147_483 s) itself overflows;
    // the ceiling must win, not the floor.
    const { pingIntervalMs, staleSec } = resolveHeartbeatLivenessConfig();
    assert.equal(pingIntervalMs, MAX_HEARTBEAT_INTERVAL_SEC * 1000);
    assert.equal(staleSec, MAX_HEARTBEAT_INTERVAL_SEC, 'the 2x floor must never exceed the ceiling');
    assert.ok(staleSec * 1000 < 2 ** 31 - 1);
  });
});

test('S241-S2: huge HEARTBEAT_PROGRESS_STALE_SEC clamps to the ceiling', () => {
  withLivenessEnv({ HEARTBEAT_PROGRESS_STALE_SEC: '3000000000' }, () => {
    assert.equal(resolveHeartbeatLivenessConfig().progressStaleSec, MAX_HEARTBEAT_INTERVAL_SEC);
  });
  withLivenessEnv({ HEARTBEAT_PROGRESS_STALE_SEC: '9'.repeat(400) }, () => {
    // +Infinity is huge, not garbage — the ceiling, never the fallback.
    assert.equal(resolveHeartbeatLivenessConfig().progressStaleSec, MAX_HEARTBEAT_INTERVAL_SEC);
  });
});

test('S241-S2: floors and fallbacks are untouched — garbage/zero/negative still fall back, sane values pass through', () => {
  for (const garbage of ['garbage', 'Infinity', '+Infinity', '0', '-5', '', '   ']) {
    withLivenessEnv({
      HEARTBEAT_PING_INTERVAL_SEC: garbage,
      HEARTBEAT_STALE_SEC: garbage,
      HEARTBEAT_PROGRESS_STALE_SEC: garbage,
    }, () => {
      const cfg = resolveHeartbeatLivenessConfig();
      assert.equal(cfg.pingIntervalMs, DEFAULT_HEARTBEAT_PING_INTERVAL_SEC * 1000, `ping "${garbage}"`);
      assert.equal(cfg.staleSec, DEFAULT_HEARTBEAT_STALE_SEC, `stale "${garbage}"`);
      assert.equal(cfg.progressStaleSec, DEFAULT_HEARTBEAT_PROGRESS_STALE_SEC, `progress "${garbage}"`);
    });
  }
  // Unset env → defaults; sane values → pass-through; the 2x floor still applies below the ceiling.
  withLivenessEnv({}, () => {
    const cfg = resolveHeartbeatLivenessConfig();
    assert.equal(cfg.pingIntervalMs, DEFAULT_HEARTBEAT_PING_INTERVAL_SEC * 1000);
    assert.equal(cfg.staleSec, DEFAULT_HEARTBEAT_STALE_SEC);
    assert.equal(cfg.progressStaleSec, DEFAULT_HEARTBEAT_PROGRESS_STALE_SEC);
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '7', HEARTBEAT_STALE_SEC: '5' }, () => {
    const cfg = resolveHeartbeatLivenessConfig();
    assert.equal(cfg.pingIntervalMs, 7_000);
    assert.equal(cfg.staleSec, 14, 'the 2x-ping floor (14) beats the requested 5');
  });
  withLivenessEnv({ HEARTBEAT_PING_INTERVAL_SEC: '7', HEARTBEAT_STALE_SEC: '60' }, () => {
    assert.equal(resolveHeartbeatLivenessConfig().staleSec, 60, 'a sane explicit stale wins over the floor');
  });
});
