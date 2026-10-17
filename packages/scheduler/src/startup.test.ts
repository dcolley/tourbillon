import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
          throw new Error(NOT_READY);
        },
        { now: clock.now, sleep: clock.sleep },
      ),
      (err: unknown) => {
        assert.ok(err instanceof DbUnavailableError);
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
          await waitForDb(async () => {
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
