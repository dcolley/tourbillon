import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { onceAsync, onShutdownSignals } from './shutdown-once';

describe('onceAsync (scheduler shutdown guard)', () => {
  it('a second and third signal reuse the first shutdown: the body runs exactly once', async () => {
    let calls = 0;
    let finish!: () => void;
    const shutdown = onceAsync(async () => {
      calls += 1;
      await new Promise<void>((r) => (finish = r));
    });
    const first = shutdown();
    const second = shutdown();
    const third = shutdown();
    assert.equal(calls, 1, 'body started once while the first shutdown is still in progress');
    assert.equal(second, first);
    assert.equal(third, first);
    finish();
    await Promise.all([first, second, third]);
    await shutdown();
    assert.equal(calls, 1, 'still once after the first shutdown finished');
  });

  it('separate guards are independent', async () => {
    let a = 0;
    let b = 0;
    const sa = onceAsync(async () => { a += 1; });
    const sb = onceAsync(async () => { b += 1; });
    await sa();
    await sa();
    await sb();
    assert.deepEqual([a, b], [1, 1]);
  });

  it('SIGTERM then SIGINT then SIGTERM: the shutdown body (and its one warning line) runs once', async () => {
    const proc = new EventEmitter();
    const lines: string[] = [];
    let finish!: () => void;
    const guarded = onShutdownSignals(proc, async () => {
      lines.push('scheduler shutdown: dropping deferred wakes');
      await new Promise<void>((r) => (finish = r));
    });
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    assert.deepEqual(lines, ['scheduler shutdown: dropping deferred wakes']);
    finish();
    await guarded();
    proc.emit('SIGINT');
    assert.equal(lines.length, 1);
  });
});
