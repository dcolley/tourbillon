/**
 * requireSecret (lib/require-secret.ts) and the lazy BETTER_AUTH_SECRET check in lib/auth.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSECURE_DEV_FALLBACK_SECRET,
  MIN_SECRET_LENGTH,
  SecretConfigError,
  requireSecret,
  secretProblem,
} from './require-secret';

const NAME = 'TOURBILLON_TEST_REQUIRED_SECRET';
const STRONG = 'Zx9pQ2mL7vR4tY8wB1nC6kH3jF5dS0aE'; // 32 chars
const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = [NAME, 'NODE_ENV', 'TOURBILLON_BOARD_AUTH_INSECURE_DEV', 'BETTER_AUTH_SECRET'];

function hdrs(host: string, forwarded?: string): Headers {
  const h = new Headers({ host });
  if (forwarded) h.set('x-forwarded-host', forwarded);
  return h;
}

function throwsConfig(fn: () => unknown, problem: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof SecretConfigError);
    assert.equal(err.problem, problem);
    assert.equal(err.variable, NAME);
    assert.match(err.message, new RegExp(NAME));
    return true;
  });
}

describe('requireSecret', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
    delete env[NAME];
    delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    env.NODE_ENV = 'development';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });

  it('unset throws', () => {
    throwsConfig(() => requireSecret(NAME), 'unset');
    env[NAME] = '   ';
    throwsConfig(() => requireSecret(NAME), 'unset');
  });

  for (const value of [
    'change-me-in-production',
    'change-me-in-production-use-openssl-rand-base64-32',
    '<generate with: openssl rand -base64 32>',
    'change-me-please-0123456789abcdefghijklmnop',
  ]) {
    it(`placeholder value throws: ${value}`, () => {
      env[NAME] = value;
      throwsConfig(() => requireSecret(NAME), 'placeholder');
    });
  }

  it('short value throws', () => {
    env[NAME] = STRONG.slice(0, MIN_SECRET_LENGTH - 1);
    throwsConfig(() => requireSecret(NAME), 'too_short');
  });

  it('32+ characters passes and is returned unchanged', () => {
    env[NAME] = STRONG;
    assert.equal(requireSecret(NAME), STRONG);
    env[NAME] = `${STRONG}${STRONG}`;
    assert.equal(requireSecret(NAME), `${STRONG}${STRONG}`);
  });

  it('applies whatever NODE_ENV is', () => {
    for (const nodeEnv of ['production', 'development', 'test']) {
      env.NODE_ENV = nodeEnv;
      delete env[NAME];
      throwsConfig(() => requireSecret(NAME, hdrs('localhost:3002')), 'unset');
      env[NAME] = STRONG;
      assert.equal(requireSecret(NAME), STRONG);
    }
  });

  it('error message names the variable but never includes the value', () => {
    for (const value of ['short-but-private-value', 'change-me-in-production']) {
      env[NAME] = value;
      try {
        requireSecret(NAME);
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof SecretConfigError);
        assert.match(err.message, new RegExp(NAME));
        assert.ok(!err.message.includes(value), 'message must not contain the value');
        assert.ok(!String(err.stack).includes(value), 'stack must not contain the value');
      }
    }
  });

  describe('local-dev opt-in (TOURBILLON_BOARD_AUTH_INSECURE_DEV=1)', () => {
    beforeEach(() => {
      env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    });

    it('loopback host: unset uses the dev fallback; short/placeholder values are returned', () => {
      for (const host of ['localhost:3002', '127.0.0.1', '[::1]:3002']) {
        delete env[NAME];
        assert.equal(requireSecret(NAME, hdrs(host)), INSECURE_DEV_FALLBACK_SECRET);
        env[NAME] = 'short';
        assert.equal(requireSecret(NAME, hdrs(host)), 'short');
        env[NAME] = 'change-me-in-production';
        assert.equal(requireSecret(NAME, hdrs(host)), 'change-me-in-production');
      }
    });

    it('non-loopback host throws', () => {
      for (const host of ['tourbillon-test.example.com', '192.168.1.10:3002', '0.0.0.0:3002']) {
        throwsConfig(() => requireSecret(NAME, hdrs(host)), 'unset');
      }
    });

    it('loopback Host with a non-loopback X-Forwarded-Host throws', () => {
      throwsConfig(() => requireSecret(NAME, hdrs('localhost:3002', 'tourbillon-test.example.com')), 'unset');
    });

    it('without request headers throws', () => {
      throwsConfig(() => requireSecret(NAME), 'unset');
      throwsConfig(() => requireSecret(NAME, null), 'unset');
    });

    it('NODE_ENV=production throws even on loopback', () => {
      env.NODE_ENV = 'production';
      throwsConfig(() => requireSecret(NAME, hdrs('localhost:3002')), 'unset');
    });

    it('flag values other than 1 are ignored', () => {
      env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = 'true';
      throwsConfig(() => requireSecret(NAME, hdrs('localhost:3002')), 'unset');
    });
  });

  it('secretProblem classifies values', () => {
    assert.equal(secretProblem(undefined), 'unset');
    assert.equal(secretProblem(''), 'unset');
    assert.equal(secretProblem('change-me-in-production'), 'placeholder');
    assert.equal(secretProblem('x'.repeat(MIN_SECRET_LENGTH - 1)), 'too_short');
    assert.equal(secretProblem(STRONG), null);
  });
});

describe('lib/auth BETTER_AUTH_SECRET check', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
    delete env.TOURBILLON_BOARD_AUTH_INSECURE_DEV;
    env.NODE_ENV = 'development';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });

  it('importing the module does not read or check the secret', async () => {
    delete env.BETTER_AUTH_SECRET;
    const mod = await import('./auth');
    assert.equal(typeof mod.getAuth, 'function');
    assert.equal(typeof mod.auth.handler, 'function');
  });

  it('getAuth throws when the secret is unset, a placeholder, or short', async () => {
    const { getAuth } = await import('./auth');
    for (const value of [undefined, 'change-me-in-production', 'too-short-secret']) {
      if (value === undefined) delete env.BETTER_AUTH_SECRET;
      else env.BETTER_AUTH_SECRET = value;
      assert.throws(() => getAuth(hdrs('tourbillon-test.example.com')), SecretConfigError);
    }
  });

  it('auth.handler rejects before handling when the secret is unset', async () => {
    delete env.BETTER_AUTH_SECRET;
    const { auth } = await import('./auth');
    const req = new Request('https://tourbillon-test.example.com/api/auth/get-session', {
      headers: { host: 'tourbillon-test.example.com' },
    });
    await assert.rejects(() => auth.handler(req), SecretConfigError);
  });

  it('getAuth returns an instance for a 32+ character secret', async () => {
    env.BETTER_AUTH_SECRET = STRONG;
    const { getAuth } = await import('./auth');
    const instance = getAuth(hdrs('tourbillon-test.example.com'));
    assert.equal(typeof instance.handler, 'function');
    assert.equal(getAuth(), instance, 'instance is reused while the secret is unchanged');
  });

  it('getAuth honours the local-dev opt-in only on loopback', async () => {
    delete env.BETTER_AUTH_SECRET;
    env.TOURBILLON_BOARD_AUTH_INSECURE_DEV = '1';
    const { getAuth } = await import('./auth');
    assert.equal(typeof getAuth(hdrs('localhost:3002')).handler, 'function');
    assert.throws(() => getAuth(hdrs('tourbillon-test.example.com')), SecretConfigError);
  });
});
