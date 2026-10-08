/**
 * validateSchedulerKey (internal routes): config is checked at first use, wrong / mismatched-length
 * keys are refused, and the config log names the reason but never the value.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetSchedulerKeyLogStateForTests, validateSchedulerKey } from './scheduler-key';

const VALID = 'web-scheduler-key-test-0123456789abcdefgh';
const env = process.env as Record<string, string | undefined>;

describe('validateSchedulerKey', () => {
  let saved: string | undefined;
  let logged: string[];
  let origError: typeof console.error;

  beforeEach(() => {
    saved = env.SCHEDULER_API_KEY;
    logged = [];
    origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    resetSchedulerKeyLogStateForTests();
  });

  afterEach(() => {
    console.error = origError;
    if (saved === undefined) delete env.SCHEDULER_API_KEY;
    else env.SCHEDULER_API_KEY = saved;
  });

  it('accepts the right key', () => {
    env.SCHEDULER_API_KEY = VALID;
    assert.equal(validateSchedulerKey(VALID), true);
    assert.equal(logged.length, 0);
  });

  it('rejects a wrong key and keys of a different length without throwing', () => {
    env.SCHEDULER_API_KEY = VALID;
    for (const k of [`${VALID.slice(0, -1)}Z`, 'short', `${VALID}-longer`, '']) {
      assert.doesNotThrow(() => validateSchedulerKey(k));
      assert.equal(validateSchedulerKey(k), false);
    }
    assert.equal(validateSchedulerKey(undefined), false);
    assert.equal(validateSchedulerKey(null), false);
  });

  it('refuses when unset, placeholder or short, logging the reason once and never the value', () => {
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /SCHEDULER_API_KEY is not set/],
      ['change-me-in-production', /SCHEDULER_API_KEY is a placeholder value/],
      ['short-secret-value-0099', /SCHEDULER_API_KEY is shorter than 32 characters/],
    ];
    for (const [value, reason] of cases) {
      resetSchedulerKeyLogStateForTests();
      logged = [];
      if (value === undefined) delete env.SCHEDULER_API_KEY;
      else env.SCHEDULER_API_KEY = value;
      const presented = value ?? 'anything-at-all';
      assert.equal(validateSchedulerKey(presented), false);
      assert.equal(validateSchedulerKey(presented), false);
      assert.equal(logged.length, 1, 'logged once per reason');
      assert.match(logged[0], reason);
      if (value) assert.ok(!logged[0].includes(value), 'log must not contain the value');
    }
  });
});
