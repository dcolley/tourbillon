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
    // Inner whitespace is not edge whitespace; it is refused by the printable-ASCII rule instead.
    assert.equal(schedulerApiKeyProblem('abcd efgh ijkl mnop qrst uvwx yz12 3456'), 'invalid_characters');
    assert.match(describeSchedulerApiKeyProblem('whitespace'), /^SCHEDULER_API_KEY has leading or trailing whitespace/);
  });

  it('any character outside printable ASCII U+0021–U+007E anywhere is refused as one reason', () => {
    const head = VALID.slice(0, 20);
    const tail = VALID.slice(20);
    const cases: Array<[string, string]> = [
      ['interior LF', `${head}\n${tail}`],
      ['interior CR', `${head}\r${tail}`],
      ['interior CRLF', `${head}\r\n${tail}`],
      ['interior zero-width space', `${head}\u200B${tail}`],
      ['interior emoji', `${head}\u{1F511}${tail}`],
      ['interior NBSP', `${head}\u00A0${tail}`],
      ['interior tab', `${head}\t${tail}`],
      ['interior space', `${head} ${tail}`],
      ['interior NUL', `${head}\u0000${tail}`],
      ['interior U+001F', `${head}\u001F${tail}`],
      ['interior DEL', `${head}\u007F${tail}`],
      ['interior U+0080', `${head}\u0080${tail}`],
      ['interior Latin-1 letter', `${head}\u00E9${tail}`],
      ['interior U+0100', `${head}\u0100${tail}`],
      ['interior U+180E', `${head}\u180E${tail}`],
      ['trailing U+180E', `${VALID}\u180E`],
      ['leading U+180E', `\u180E${VALID}`],
      ['interior word joiner', `${head}\u2060${tail}`],
      ['interior BOM', `${head}\uFEFF${tail}`],
      ['short value with a control character', 'abc\u0001'],
    ];
    for (const [label, value] of cases) {
      assert.equal(schedulerApiKeyProblem(value), 'invalid_characters', label);
      assert.equal(isSchedulerApiKeyConfigured(env(value)), false, label);
      assert.throws(
        () => requireSchedulerApiKey(env(value)),
        (e: unknown) =>
          e instanceof SchedulerKeyConfigError &&
          e.reason === 'invalid_characters' &&
          !e.message.includes(head) &&
          !e.message.includes(tail),
        label,
      );
      // Refused for every presented key, including the exact configured string.
      assert.deepEqual(checkSchedulerApiKey(value, env(value)), {
        ok: false,
        reason: 'config',
        problem: 'invalid_characters',
      });
      assert.deepEqual(checkSchedulerApiKey(VALID, env(value)), {
        ok: false,
        reason: 'config',
        problem: 'invalid_characters',
      });
    }
    const text = describeSchedulerApiKeyProblem('invalid_characters');
    assert.match(text, /^SCHEDULER_API_KEY contains characters outside printable ASCII/);
    assert.match(text, /U\+0021–U\+007E/);
  });

  it('normal base64, base64url and hex keys pass, including the U+0021 and U+007E boundaries', () => {
    for (const [label, value] of [
      ['base64 (openssl rand -base64 32)', 'q3Zr+8Lw/2Kp7Tn0Yx5Vb1Mc4Hd6Jf9Gs3Ae2Ru8Wo='],
      ['base64url', 'q3Zr-8Lw_2Kp7Tn0Yx5Vb1Mc4Hd6Jf9Gs3Ae2Ru8Wo'],
      ['hex', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
      ['every printable ASCII character', Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('')],
      ['boundaries', `!${'k'.repeat(SCHEDULER_API_KEY_MIN_LENGTH - 2)}~`],
    ] as const) {
      assert.equal(schedulerApiKeyProblem(value), null, label);
      assert.equal(requireSchedulerApiKey(env(value)), value, label);
      assert.deepEqual(checkSchedulerApiKey(value, env(value)), { ok: true }, label);
    }
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
    for (const r of ['unset', 'whitespace', 'placeholder', 'invalid_characters', 'too_short'] as const) {
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
