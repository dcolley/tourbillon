import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, mock } from 'node:test';
import { DbUnavailableError, runSchedulerMain, waitForDb } from './startup';

const NOT_READY = 'the database system is not yet accepting connections';

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('waitForDb', () => {
  it('retries with backoff and succeeds once the database accepts connections', async () => {
    const clock = fakeClock();
    let calls = 0;
    const retries: number[] = [];
    const attempts = await waitForDb(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error(NOT_READY);
      },
      { now: clock.now, sleep: clock.sleep, onRetry: (r) => retries.push(r.attempt) },
    );
    assert.equal(attempts, 4);
    assert.equal(calls, 4);
    assert.deepEqual(clock.sleeps, [500, 1000, 2000]);
    assert.deepEqual(retries, [1, 2, 3]);
  });

  it('caps the delay and gives up after ~2 minutes with DbUnavailableError', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      waitForDb(
        async () => {
          calls += 1;
          // Runaway guard: if the deadline were ignored this fails the test instead of hanging it.
          if (calls > 200) throw Object.assign(new Error('runaway: deadline ignored'), { code: '28P01' });
          throw new Error(NOT_READY);
        },
        { now: clock.now, sleep: clock.sleep },
      ),
      (err: unknown) => {
        assert.ok(err instanceof DbUnavailableError);
        assert.equal(err.fatal, false, 'gave up on the deadline, not via the runaway guard');
        assert.equal(err.attempts, calls);
        assert.match(err.message, /not yet accepting connections/);
        return true;
      },
    );
    assert.equal(clock.now(), 120_000, 'total wait is exactly the 2 min budget');
    assert.ok(Math.max(...clock.sleeps) <= 10_000, 'delay capped at 10 s');
    assert.ok(calls > 5 && calls < 30, `bounded attempts (${calls})`);
  });
});

describe('runSchedulerMain', () => {
  const silent = () => {
    const errors: Array<Record<string, unknown> | undefined> = [];
    return { logger: { info: () => undefined, error: (_m: string, d?: Record<string, unknown>) => errors.push(d) }, errors };
  };

  it('retry-then-succeed: start completes, no exit', async () => {
    const clock = fakeClock();
    let calls = 0;
    const exits: number[] = [];
    const { logger } = silent();
    await runSchedulerMain(
      async () => {
        await waitForDb(
          async () => {
            calls += 1;
            if (calls < 3) throw new Error(NOT_READY);
          },
          { now: clock.now, sleep: clock.sleep },
        );
      },
      logger,
      (c) => exits.push(c),
    );
    assert.deepEqual(exits, []);
    assert.equal(calls, 3);
  });

  it('give-up: exits non-zero (1) so systemd restarts the unit, logging no secrets', async () => {
    const clock = fakeClock();
    const exits: number[] = [];
    const { logger, errors } = silent();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:s3cr3t-pw@db:5432/x';
    try {
      await runSchedulerMain(
        async () => {
          let calls = 0;
          await waitForDb(async () => {
            calls += 1;
            if (calls > 200) throw Object.assign(new Error('runaway: deadline ignored'), { code: '28P01' }); // fail, don't hang
            throw new Error(NOT_READY);
          }, { now: clock.now, sleep: clock.sleep });
        },
        logger,
        (c) => exits.push(c),
      );
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
    assert.deepEqual(exits, [1]);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(JSON.stringify(errors), /s3cr3t-pw|postgres:\/\//);
  });
});

const PW = 'Sup3r-s3cret-pw';
const URL_WITH_PW = `postgres://tb_user:${PW}@db.internal:5432/tourbillon`;

/** What drizzle throws: a generic wrapper with the driver error in `cause`, plus noisy fields. */
function drizzleStyleError(message: string, code: string): Error {
  const cause = Object.assign(new Error(message), { code, severity: 'FATAL', connection: URL_WITH_PW });
  return Object.assign(new Error('Failed query: select 1\nparams: ', { cause }), { query: 'select 1', params: [] });
}

function withEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });
}

describe('waitForDb: sanitised underlying error', () => {
  it('onRetry gets the driver message and code, not the drizzle wrapper, and no URL/password', async () => {
    const clock = fakeClock();
    let calls = 0;
    const seen: Array<{ error: string; code?: string }> = [];
    await withEnv(URL_WITH_PW, () =>
      waitForDb(
        async () => {
          calls += 1;
          if (calls < 3) throw drizzleStyleError(`connect ECONNREFUSED via ${URL_WITH_PW}`, 'ECONNREFUSED');
        },
        { now: clock.now, sleep: clock.sleep, onRetry: ({ error, code }) => seen.push({ error, code }) },
      ),
    );
    assert.equal(seen.length, 2);
    for (const r of seen) {
      assert.equal(r.code, 'ECONNREFUSED');
      assert.match(r.error, /^connect ECONNREFUSED via \[redacted\]$/);
      assert.doesNotMatch(r.error, /Failed query|s3cret|postgres:\/\//);
    }
  });
});

describe('waitForDb: fail fast on errors retrying cannot fix', () => {
  for (const [code, message] of [
    ['28P01', 'password authentication failed for user "tb_user"'],
    ['28000', 'no pg_hba.conf entry for host "10.0.0.9", user "tb_user", database "tourbillon"'],
    ['3D000', 'database "tourbillon" does not exist'],
    ['42704', 'role "tb_user" does not exist'],
    ['55P02', 'parameter "max_connections" cannot be changed now'],
    ['DATABASE_URL_INVALID', 'DATABASE_URL is not a valid postgres connection URL (unparseable)'],
  ] as const) {
    it(`${code}: one attempt, no sleep, fatal DbUnavailableError`, async () => {
      const clock = fakeClock();
      let calls = 0;
      await assert.rejects(
        waitForDb(
          async () => {
            calls += 1;
            throw drizzleStyleError(message, code);
          },
          { now: clock.now, sleep: clock.sleep },
        ),
        (err: unknown) => {
          assert.ok(err instanceof DbUnavailableError);
          assert.equal(err.fatal, true);
          assert.equal(err.code, code);
          assert.equal(err.attempts, 1);
          assert.equal(err.lastError, message);
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.deepEqual(clock.sleeps, []);
    });
  }

  it('transient codes (57P03 starting up, ECONNREFUSED) are retried', async () => {
    for (const code of ['57P03', 'ECONNREFUSED']) {
      const clock = fakeClock();
      let calls = 0;
      const attempts = await waitForDb(
        async () => {
          calls += 1;
          if (calls < 2) throw drizzleStyleError(NOT_READY, code);
        },
        { now: clock.now, sleep: clock.sleep },
      );
      assert.equal(attempts, 2, code);
    }
  });
});

describe('waitForDb: per-attempt timeout (fake timers)', () => {
  it('a probe that never settles is aborted after attemptTimeoutMs and retried', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const clock = fakeClock();
      const signals: AbortSignal[] = [];
      const retries: Array<{ code?: string; error: string }> = [];
      let calls = 0;
      const done = waitForDb(
        (signal) => {
          calls += 1;
          signals.push(signal);
          if (calls === 1) return new Promise<never>(() => undefined); // stalled after connect
          return Promise.resolve();
        },
        {
          attemptTimeoutMs: 1_000,
          now: clock.now,
          sleep: clock.sleep,
          onRetry: (r) => retries.push({ code: r.code, error: r.error }),
        },
      );
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(signals[0]!.aborted, false);
      mock.timers.tick(999);
      await Promise.resolve();
      assert.equal(calls, 1, 'not yet timed out');
      mock.timers.tick(1);
      // setImmediate is not mocked: it runs once the retry's microtasks drain. If the attempt were not
      // bounded, `done` would still be pending here and the test fails instead of hanging.
      const settled = await Promise.race([done, new Promise((r) => setImmediate(() => r('still pending')))]);
      assert.equal(settled, 2);
      assert.equal(signals[0]!.aborted, true, 'stalled attempt was aborted');
      assert.deepEqual(retries, [{ code: 'PROBE_TIMEOUT', error: 'database probe timed out after 1000 ms' }]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('runSchedulerMain: give-up log carries only sanitised fields', () => {
  const capture = () => {
    const lines: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    return {
      logger: { info: () => undefined, error: (msg: string, data?: Record<string, unknown>) => lines.push({ msg, data }) },
      lines,
    };
  };

  it('deadline give-up: exactly error/code/attempts/retried, no URL, password, wrapper text or stack', async () => {
    const clock = fakeClock();
    let calls = 0;
    const exits: number[] = [];
    const { logger, lines } = capture();
    await withEnv(URL_WITH_PW, () =>
      runSchedulerMain(
        () =>
          waitForDb(async () => {
            calls += 1;
            if (calls > 200) throw Object.assign(new Error('runaway: deadline ignored'), { code: '28P01' }); // fail, don't hang
            throw drizzleStyleError(`connect ETIMEDOUT ${URL_WITH_PW} password=${PW}`, 'ETIMEDOUT');
          }, { now: clock.now, sleep: clock.sleep }).then(() => undefined),
        logger,
        (c) => exits.push(c),
      ),
    );
    assert.deepEqual(exits, [1]);
    assert.equal(lines.length, 1);
    const data = lines[0]!.data!;
    assert.deepEqual(Object.keys(data).sort(), ['attempts', 'code', 'error', 'retried']);
    assert.equal(data.code, 'ETIMEDOUT');
    assert.equal(data.retried, true);
    assert.equal(data.error, 'connect ETIMEDOUT [redacted] password=[redacted]');
    const all = JSON.stringify(lines);
    assert.doesNotMatch(all, /s3cret|postgres:\/\/|Failed query|db\.internal|\bat \S+:\d+/);
  });

  it('fatal auth error: exits 1 at once with retried=false', async () => {
    const clock = fakeClock();
    const exits: number[] = [];
    const { logger, lines } = capture();
    await runSchedulerMain(
      () =>
        waitForDb(async () => {
          throw drizzleStyleError('password authentication failed for user "tb_user"', '28P01');
        }, { now: clock.now, sleep: clock.sleep }).then(() => undefined),
      logger,
      (c) => exits.push(c),
    );
    assert.deepEqual(exits, [1]);
    assert.deepEqual(lines[0]!.data, {
      error: 'password authentication failed for user "tb_user"',
      code: '28P01',
      attempts: 1,
      retried: false,
    });
  });

  it('any other startup error (e.g. a URL TypeError carrying its input): only error/code', async () => {
    const exits: number[] = [];
    const { logger, lines } = capture();
    await withEnv(URL_WITH_PW, () =>
      runSchedulerMain(
        async () => {
          throw Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL', input: URL_WITH_PW });
        },
        logger,
        (c) => exits.push(c),
      ),
    );
    assert.deepEqual(exits, [1]);
    assert.deepEqual(lines[0]!.data, { error: 'Invalid URL', code: 'ERR_INVALID_URL' });
  });
});

describe('scheduler entry: malformed DATABASE_URL', () => {
  // S256-S3 raised this pin's budget for the parallel multi-worktree gate; S266-S2 corrects
  // WHICH budget actually governs it. The body is FULLY SYNCHRONOUS — spawnSync blocks the
  // event loop, so node:test's per-test `{ timeout }` option can never fire mid-body (its
  // watchdog timer cannot preempt a sync block) and was a no-op. The single real wall is the
  // spawnSync `timeout` option below: on expiry libuv SIGTERMs the tsx child and spawnSync
  // returns, so the test fails BY NAME with the captured output instead of the whole file
  // hitting the runner wall. A raise has to go on SPAWN_TIMEOUT_MS — not on a test option.
  const SPAWN_TIMEOUT_MS = 180_000;
  it(
    'exits 1 with one sanitised line before loading anything that connects',
    () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const tsxCli = path.resolve(here, '../node_modules/.bin/tsx');
      const res = spawnSync(tsxCli, [path.join(here, 'index.ts')], {
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: `postgres://tb_user:${PW}@db.internal:99999/tourbillon` },
        encoding: 'utf-8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      const out = `${res.stdout}\n${res.stderr}`;
      assert.equal(res.status, 1, out);
      assert.match(out, /failed to start/);
      assert.match(out, /DATABASE_URL_INVALID/);
      assert.doesNotMatch(out, /s3cret|db\.internal|postgres:\/\//);
      assert.doesNotMatch(out, /database not ready; retrying/, 'not retried');
    },
  );
});
