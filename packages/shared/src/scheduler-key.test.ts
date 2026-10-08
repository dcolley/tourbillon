import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_API_KEY_MIN_LENGTH,
  SchedulerKeyConfigError,
  bearerTokenFromHeader,
  checkSchedulerApiKey,
  describeSchedulerApiKeyProblem,
  isSchedulerApiKeyConfigured,
  requireSchedulerApiKey,
  schedulerApiKeyProblem,
  schedulerKeyMatches,
} from './scheduler-key';

const VALID = 'sched-key-test-value-0123456789abcdefXYZ';
const env = (value: string | undefined) => ({ SCHEDULER_API_KEY: value });

describe('scheduler-key config', () => {
  it('unset or blank is refused', () => {
    assert.equal(schedulerApiKeyProblem(undefined), 'unset');
    assert.equal(schedulerApiKeyProblem(null), 'unset');
    assert.equal(schedulerApiKeyProblem(''), 'unset');
    assert.equal(schedulerApiKeyProblem('   '), 'unset');
    assert.throws(() => requireSchedulerApiKey(env(undefined)), SchedulerKeyConfigError);
    assert.equal(isSchedulerApiKeyConfigured(env(undefined)), false);
  });

  it('placeholders from .env.example and docs are refused', () => {
    for (const p of [
      'change-me-in-production',
      'CHANGE-ME-IN-PRODUCTION',
      'dev-scheduler-key',
      '<generate with: openssl rand -base64 32>',
      'change-me-in-production-please-0123456789',
      'changeme-changeme-changeme-changeme-1234',
    ]) {
      assert.equal(schedulerApiKeyProblem(p), 'placeholder', p);
      assert.throws(() => requireSchedulerApiKey(env(p)), (e: unknown) => {
        return e instanceof SchedulerKeyConfigError && e.reason === 'placeholder';
      });
    }
  });

  it('leading or trailing whitespace is refused as its own reason and never trimmed', () => {
    const visible = 'Zq7Lw2'; // 6 visible characters
    const cases: Array<[string, string]> = [
      ['space-padded short value reaching 32', `${visible}${' '.repeat(SCHEDULER_API_KEY_MIN_LENGTH - visible.length)}`],
      ['leading spaces', `   ${VALID}`],
      ['trailing space', `${VALID} `],
      ['trailing newline', `${VALID}\n`],
      ['trailing CRLF', `${VALID}\r\n`],
      ['leading tab', `\t${VALID}`],
      ['leading BOM', `\uFEFF${VALID}`],
      ['trailing zero-width space', `${VALID}\u200B`],
      ['padded placeholder', ' change-me-in-production '],
    ];
    for (const [label, value] of cases) {
      assert.equal(schedulerApiKeyProblem(value), 'whitespace', label);
      assert.equal(isSchedulerApiKeyConfigured(env(value)), false, label);
      assert.throws(
        () => requireSchedulerApiKey(env(value)),
        (e: unknown) => e instanceof SchedulerKeyConfigError && e.reason === 'whitespace',
        label,
      );
      // A padded value is refused for every presented key, including the exact configured string.
      assert.deepEqual(checkSchedulerApiKey(value, env(value)), { ok: false, reason: 'config', problem: 'whitespace' });
      assert.deepEqual(checkSchedulerApiKey(VALID, env(value)), { ok: false, reason: 'config', problem: 'whitespace' });
    }
    assert.equal(
      `${visible}${' '.repeat(SCHEDULER_API_KEY_MIN_LENGTH - visible.length)}`.length,
      SCHEDULER_API_KEY_MIN_LENGTH,
    );
    // Inner whitespace is not edge whitespace: only the length / placeholder rules apply.
    assert.equal(schedulerApiKeyProblem('abcd efgh ijkl mnop qrst uvwx yz12 3456'), null);
    assert.match(describeSchedulerApiKeyProblem('whitespace'), /^SCHEDULER_API_KEY has leading or trailing whitespace/);
  });

  it('shorter than the minimum is refused', () => {
    const short = 'x'.repeat(SCHEDULER_API_KEY_MIN_LENGTH - 1);
    assert.equal(schedulerApiKeyProblem(short), 'too_short');
    assert.throws(() => requireSchedulerApiKey(env(short)), (e: unknown) => {
      return e instanceof SchedulerKeyConfigError && e.reason === 'too_short';
    });
  });

  it('a valid key passes', () => {
    assert.equal(schedulerApiKeyProblem(VALID), null);
    assert.equal(schedulerApiKeyProblem('y'.repeat(SCHEDULER_API_KEY_MIN_LENGTH)), null);
    assert.equal(requireSchedulerApiKey(env(VALID)), VALID);
    assert.equal(isSchedulerApiKeyConfigured(env(VALID)), true);
  });

  it('error messages name the reason, never the value or its length', () => {
    const secretish = 'short-but-secret-value-77'; // 25 chars
    assert.equal(secretish.length, 25);
    try {
      requireSchedulerApiKey(env(secretish));
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof SchedulerKeyConfigError);
      assert.ok(!e.message.includes(secretish));
      assert.ok(!/\b25\b/.test(e.message), 'message must not contain the value length');
      assert.match(e.message, /SCHEDULER_API_KEY is shorter than 32 characters/);
      assert.match(e.message, /openssl rand -base64 32/);
    }
    const padded = `${VALID}\n`; // 41 chars
    assert.equal(padded.length, 41);
    try {
      requireSchedulerApiKey(env(padded));
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof SchedulerKeyConfigError);
      assert.ok(!e.message.includes(VALID));
      assert.ok(!/\b(40|41)\b/.test(e.message), 'message must not contain the value length');
    }
    for (const r of ['unset', 'whitespace', 'placeholder', 'too_short'] as const) {
      assert.match(describeSchedulerApiKeyProblem(r), /^SCHEDULER_API_KEY /);
    }
  });
});

describe('scheduler-key comparison', () => {
  it('the right key is accepted', () => {
    assert.equal(schedulerKeyMatches(VALID, VALID), true);
    assert.deepEqual(checkSchedulerApiKey(VALID, env(VALID)), { ok: true });
  });

  it('a wrong key of the same length is rejected', () => {
    const wrong = `${VALID.slice(0, -1)}Q`;
    assert.equal(wrong.length, VALID.length);
    assert.equal(schedulerKeyMatches(wrong, VALID), false);
    assert.deepEqual(checkSchedulerApiKey(wrong, env(VALID)), { ok: false, reason: 'mismatch' });
  });

  it('keys of a different length are rejected without throwing', () => {
    for (const k of ['a', VALID.slice(0, 10), `${VALID}extra`, VALID.repeat(20)]) {
      assert.doesNotThrow(() => schedulerKeyMatches(k, VALID));
      assert.equal(schedulerKeyMatches(k, VALID), false);
    }
  });

  it('empty and non-string input is rejected', () => {
    for (const k of ['', undefined, null, 123, {}, [VALID]]) {
      assert.equal(schedulerKeyMatches(k, VALID), false);
    }
    assert.equal(schedulerKeyMatches(VALID, ''), false);
  });

  it('a misconfigured key refuses every presented key, including the configured value', () => {
    for (const bad of [undefined, 'change-me-in-production', 'short-key']) {
      const r = checkSchedulerApiKey(bad ?? 'anything', env(bad));
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, 'config');
    }
  });

  it('bearer header parsing', () => {
    assert.equal(bearerTokenFromHeader(`Bearer ${VALID}`), VALID);
    assert.equal(bearerTokenFromHeader(VALID), '');
    assert.equal(bearerTokenFromHeader('bearer x'), '');
    assert.equal(bearerTokenFromHeader(undefined), '');
    assert.equal(bearerTokenFromHeader(null), '');
  });
});
