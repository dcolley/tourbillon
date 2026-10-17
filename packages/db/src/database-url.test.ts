import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import {
  DatabaseUrlError,
  assertValidDatabaseUrl,
  checkDatabaseUrl,
  describeDatabaseTarget,
  describeDbError,
  requireDatabaseUrl,
  sanitizeDbErrorText,
} from './database-url';

const PW = 'Sup3r-s3cret';
const GOOD = `postgres://tb_user:${PW}@db.internal:5432/tourbillon`;

/** Malformed values of different kinds; each embeds the password. */
const MALFORMED: Array<[string, string]> = [
  [`postgres://tb_user:${PW}@db.internal:99999/tourbillon`, 'unparseable'],
  [`postgres://tb_user:${PW}%ZZ@db.internal/tourbillon`, 'bad-encoding'],
  [`tb_user:${PW}@db.internal/tourbillon`, 'bad-scheme'],
  [`postgres://tb_user:${PW}@db internal/tourbillon`, 'unparseable'],
];

function everythingAbout(err: unknown): string {
  const e = err as { stack?: string };
  return [String(err), e?.stack ?? '', inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)].join('\n');
}

describe('checkDatabaseUrl / assertValidDatabaseUrl', () => {
  it('accepts normal, multi-host, socket and unset URLs', () => {
    assert.equal(checkDatabaseUrl(GOOD), null);
    assert.equal(checkDatabaseUrl('postgresql://u:p@h1:5432,h2:5433/db?sslmode=require'), null);
    // Same as the driver: an empty host with ?host= is not a WHATWG URL, so postgres-js rejects it too.
    assert.equal(checkDatabaseUrl('postgres://u@/db?host=/var/run/postgresql'), 'unparseable');
    assert.equal(checkDatabaseUrl('postgres:///db'), null);
    assert.equal(checkDatabaseUrl(undefined), null);
    assert.equal(checkDatabaseUrl(''), null);
  });

  for (const [raw, problem] of MALFORMED) {
    it(`rejects ${problem} without echoing the value`, () => {
      assert.equal(checkDatabaseUrl(raw), problem);
      let caught: unknown;
      try {
        assertValidDatabaseUrl(raw);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof DatabaseUrlError);
      assert.equal(caught.code, 'DATABASE_URL_INVALID');
      assert.equal((caught as { cause?: unknown }).cause, undefined);
      const all = everythingAbout(caught);
      assert.ok(!all.includes(PW), 'password must not appear in message, stack or inspect');
      assert.ok(!all.includes('db.internal'), 'raw value must not appear');
    });
  }

  it('requireDatabaseUrl keeps the missing message and validates', () => {
    assert.throws(() => requireDatabaseUrl('x storage', undefined), /DATABASE_URL is required for x storage/);
    assert.throws(() => requireDatabaseUrl('x', MALFORMED[0]![0]), DatabaseUrlError);
    assert.equal(requireDatabaseUrl('x', GOOD), GOOD);
  });
});

describe('describeDatabaseTarget', () => {
  it('returns user/host/port/db only', () => {
    assert.deepEqual(describeDatabaseTarget(GOOD), {
      user: 'tb_user',
      host: 'db.internal',
      port: '5432',
      database: 'tourbillon',
    });
    assert.ok(!JSON.stringify(describeDatabaseTarget(GOOD)).includes(PW));
    assert.equal(describeDatabaseTarget(MALFORMED[0]![0]), null);
  });
});

describe('describeDbError', () => {
  it('unwraps the drizzle wrapper to the driver message and code', () => {
    const cause = Object.assign(new Error('password authentication failed for user "tb_user"'), { code: '28P01' });
    const wrapped = new Error('Failed query: select 1\nparams: ', { cause });
    assert.deepEqual(describeDbError(wrapped, GOOD), {
      message: 'password authentication failed for user "tb_user"',
      code: '28P01',
    });
  });

  it('takes the first entry of an AggregateError (multi-address connect)', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    const agg = Object.assign(new AggregateError([inner], ''), { code: 'ECONNREFUSED' });
    assert.deepEqual(describeDbError(new Error('Failed query: select 1', { cause: agg }), GOOD), {
      message: 'connect ECONNREFUSED 10.0.0.5:5432',
      code: 'ECONNREFUSED',
    });
  });

  it('redacts the URL, the password, any URL with credentials and password= params', () => {
    const err = new Error(
      `boom ${GOOD} and ${PW} and ${encodeURIComponent(PW)} and mysql://a:b@c/d and password=hunter22 end`,
    );
    const { message } = describeDbError(err, GOOD);
    assert.ok(!message.includes(PW));
    assert.ok(!message.includes('a:b@c'));
    assert.ok(!message.includes('hunter22'));
    assert.match(message, /^boom \[redacted\]/);
  });

  it('redacts the password of a malformed URL too', () => {
    const raw = MALFORMED[0]![0];
    assert.ok(!sanitizeDbErrorText(`x ${PW} y`, raw).includes(PW));
  });

  it('drops non-alphanumeric codes and caps length', () => {
    const r = describeDbError(Object.assign(new Error('x'.repeat(2000)), { code: 'bad code; rm' }), GOOD);
    assert.equal(r.code, undefined);
    assert.ok(r.message.length <= 301);
  });
});

describe('db client import with a malformed DATABASE_URL', () => {
  it('fails with the fixed message only (no URL, password or driver error in output)', async () => {
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const res = spawnSync(path.resolve(here, '../node_modules/.bin/tsx'), ['src/client.ts'], {
      cwd: path.resolve(here, '..'),
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: MALFORMED[0]![0] },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.notEqual(res.status, 0, out);
    assert.match(out, /DATABASE_URL is not a valid postgres connection URL \(unparseable\)/);
    assert.ok(!out.includes(PW) && !out.includes('db.internal'), out);
  });
});

describe('drizzle-kit config with a malformed DATABASE_URL', () => {
  it('fails with the fixed message only', async () => {
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const res = spawnSync(path.resolve(here, '../node_modules/.bin/tsx'), ['drizzle.config.ts'], {
      cwd: path.resolve(here, '..'),
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: MALFORMED[0]![0] },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.notEqual(res.status, 0, out);
    assert.match(out, /DATABASE_URL is not a valid postgres connection URL \(unparseable\)/);
    assert.ok(!out.includes(PW) && !out.includes('db.internal'), out);
  });
});
