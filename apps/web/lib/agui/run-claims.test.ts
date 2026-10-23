/** AGUI-1: run claims (one AG-UI run per thread and per session). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeAguiRun, claimAguiRun, isAguiRunClaimed, isAguiThreadClaimedByOtherSession } from './run-claims';

describe('AG-UI run claims', () => {
  it('one claim per thread and per session; released claims can be taken again', () => {
    const s1 = {};
    const s2 = {};
    const c = claimAguiRun(s1, 'r', 't1');
    assert.ok(c);
    assert.equal(claimAguiRun(s1, 'r', 't1'), null, 'same session, same thread');
    assert.equal(claimAguiRun(s2, 'r', 't1'), null, 'other session, same thread');
    assert.equal(claimAguiRun(s1, 'r', 't2'), null, 'same session, other thread');
    assert.ok(isAguiRunClaimed(s2, 'r', 't1'));
    assert.equal(activeAguiRun(s1, 'r', 't1'), c);
    assert.equal(activeAguiRun(s2, 'r', 't1'), undefined);
    c.release();
    c.release();
    assert.equal(isAguiRunClaimed(s1, 'r', 't1'), false);
    const again = claimAguiRun(s2, 'r', 't1');
    assert.ok(again);
    again.release();
  });

  it('queued turns run in order and are dropped on release', async () => {
    const s = {};
    const c = claimAguiRun(s, 'r', 'q')!;
    const order: number[] = [];
    assert.equal(c.queueTurn(async () => void order.push(1)), 1);
    assert.equal(c.queueTurn(async () => void order.push(2)), 2);
    await c.takeQueuedTurn()!();
    assert.equal(c.queuedTurns(), 1);
    c.release();
    assert.equal(c.takeQueuedTurn(), undefined);
    assert.equal(c.queueTurn(async () => void order.push(3)), 0);
    assert.deepEqual(order, [1]);
  });

  it('a thread claimed by another session is reported as such; the owner and free threads are not', () => {
    const owner = {};
    const other = {};
    const c = claimAguiRun(owner, 'r', 'o1')!;
    assert.equal(isAguiThreadClaimedByOtherSession(other, 'r', 'o1'), true);
    assert.equal(isAguiThreadClaimedByOtherSession(owner, 'r', 'o1'), false);
    assert.equal(isAguiThreadClaimedByOtherSession(other, 'r', 'o2'), false);
    assert.equal(isAguiThreadClaimedByOtherSession(other, 'r2', 'o1'), false, 'other resource');
    c.release();
    assert.equal(isAguiThreadClaimedByOtherSession(other, 'r', 'o1'), false);
  });

  it('dropping queued turns reports how many were dropped', () => {
    const c = claimAguiRun({}, 'r', 'd')!;
    c.queueTurn(async () => {});
    c.queueTurn(async () => {});
    assert.equal(c.dropQueuedTurns(), 2);
    assert.equal(c.dropQueuedTurns(), 0);
    c.queueTurn(async () => {});
    assert.equal(c.dropQueuedTurns(), 1);
    assert.equal(c.droppedTurns(), 3);
    assert.equal(c.queuedTurns(), 0);
    c.release();
  });
});
