import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerKeyConfigError } from '@tourbillon/shared/scheduler-key';
import { assertSchedulerApiKeyAtStartup, authorizeSchedulerRequest } from './scheduler-auth';

const VALID = 'scheduler-auth-test-key-0123456789abcdef';

function captureLog() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      error(message: string, data?: Record<string, unknown>) {
        lines.push(`${message} ${JSON.stringify(data ?? {})}`);
      },
    },
  };
}

describe('scheduler startup key check', () => {
  it('refuses to start when unset, placeholder or short, and logs the reason without the value', () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'unset'],
      ['', 'unset'],
      ['change-me-in-production', 'placeholder'],
      ['<generate with: openssl rand -base64 32>', 'placeholder'],
      ['short-secret-value-0042', 'too_short'],
    ];
    for (const [value, reason] of cases) {
      const { lines, log } = captureLog();
      assert.throws(
        () => assertSchedulerApiKeyAtStartup(log, { SCHEDULER_API_KEY: value }),
        (e: unknown) => e instanceof SchedulerKeyConfigError && e.reason === reason,
      );
      assert.equal(lines.length, 1);
      assert.match(lines[0], /refusing to start: SCHEDULER_API_KEY/);
      assert.ok(lines[0].includes(`"reason":"${reason}"`));
      if (value) assert.ok(!lines[0].includes(value), `log must not contain the value (${reason})`);
    }
  });

  it('starts with a valid key and logs nothing', () => {
    const { lines, log } = captureLog();
    assert.doesNotThrow(() => assertSchedulerApiKeyAtStartup(log, { SCHEDULER_API_KEY: VALID }));
    assert.equal(lines.length, 0);
  });
});

describe('wake-server request authorization', () => {
  const env = { SCHEDULER_API_KEY: VALID };

  it('accepts the right bearer key', () => {
    assert.equal(authorizeSchedulerRequest(`Bearer ${VALID}`, env), true);
    assert.equal(authorizeSchedulerRequest([`Bearer ${VALID}`], env), true);
  });

  it('rejects a wrong key, other lengths, missing or malformed headers', () => {
    for (const h of [
      `Bearer ${VALID.slice(0, -1)}x`,
      `Bearer ${VALID}0`,
      'Bearer x',
      'Bearer ',
      VALID,
      undefined,
    ]) {
      assert.doesNotThrow(() => authorizeSchedulerRequest(h, env));
      assert.equal(authorizeSchedulerRequest(h, env), false, String(h));
    }
  });

  it('rejects everything when the configured key is unusable', () => {
    assert.equal(authorizeSchedulerRequest('Bearer ', { SCHEDULER_API_KEY: '' }), false);
    assert.equal(authorizeSchedulerRequest('Bearer undefined', { SCHEDULER_API_KEY: undefined }), false);
    assert.equal(
      authorizeSchedulerRequest('Bearer change-me-in-production', { SCHEDULER_API_KEY: 'change-me-in-production' }),
      false,
    );
  });
});
