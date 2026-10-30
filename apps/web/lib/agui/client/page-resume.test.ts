/** STREAM-1: page-resume.ts fires when the page comes back (tab shown again, bfcache restore, online). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchPageResume, type PageResumeReason } from './page-resume';

function fakePage() {
  const make = () => {
    const listeners = new Map<string, Set<(e: Event) => void>>();
    return {
      listeners,
      addEventListener: (t: string, l: (e: Event) => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
      },
      removeEventListener: (t: string, l: (e: Event) => void) => void listeners.get(t)?.delete(l),
      dispatch: (t: string, extra: Record<string, unknown> = {}) => {
        for (const l of listeners.get(t) ?? []) l(Object.assign(new Event(t), extra));
      },
    };
  };
  const doc = Object.assign(make(), { visibilityState: 'visible' as string });
  const win = make();
  let now = 0;
  return { doc, win, clock: { now: () => now, advance: (ms: number) => void (now += ms) } };
}

describe('STREAM-1 watchPageResume', () => {
  it('fires when shown again after being hidden long enough; not on a quick flick', () => {
    const { doc, win, clock } = fakePage();
    const seen: PageResumeReason[] = [];
    watchPageResume((r) => seen.push(r), { document: doc, window: win, now: clock.now, minHiddenMs: 1000 });
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    clock.advance(200);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    assert.deepEqual(seen, []);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    clock.advance(5000);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    assert.deepEqual(seen, ['visible']);
    // A second "visible" without being hidden in between does not fire again.
    doc.dispatch('visibilitychange');
    assert.deepEqual(seen, ['visible']);
  });

  it('fires on a bfcache pageshow and on online; unsubscribes', () => {
    const { doc, win, clock } = fakePage();
    const seen: PageResumeReason[] = [];
    const stop = watchPageResume((r) => seen.push(r), { document: doc, window: win, now: clock.now });
    win.dispatch('pageshow', { persisted: false });
    win.dispatch('pageshow', { persisted: true });
    win.dispatch('online');
    assert.deepEqual(seen, ['pageshow', 'online']);
    stop();
    win.dispatch('online');
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    clock.advance(5000);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    assert.deepEqual(seen, ['pageshow', 'online']);
    assert.equal(doc.listeners.get('visibilitychange')?.size, 0);
  });

  it('a page loaded hidden counts as away from the start; a throwing listener is contained', () => {
    const { doc, win, clock } = fakePage();
    doc.visibilityState = 'hidden';
    let calls = 0;
    watchPageResume(
      () => {
        calls++;
        throw new Error('boom');
      },
      { document: doc, window: win, now: clock.now },
    );
    clock.advance(2000);
    doc.visibilityState = 'visible';
    assert.doesNotThrow(() => doc.dispatch('visibilitychange'));
    assert.equal(calls, 1);
  });

  it('counts a pagehide without a visibilitychange (mobile app switch) as away', () => {
    const { doc, win, clock } = fakePage();
    const seen: PageResumeReason[] = [];
    watchPageResume((r) => seen.push(r), { document: doc, window: win, now: clock.now, minHiddenMs: 1000 });
    // iPad Safari may freeze the tab on app switch without ever reporting `hidden`.
    win.dispatch('pagehide');
    clock.advance(5000);
    doc.dispatch('visibilitychange'); // back, still reported visible
    assert.deepEqual(seen, ['visible']);
    // A quick pagehide/return inside the window is not "away".
    win.dispatch('pagehide');
    clock.advance(200);
    doc.dispatch('visibilitychange');
    assert.deepEqual(seen, ['visible']);
  });

  it('is a no-op without a document or window (server render)', () => {
    const stop = watchPageResume(() => {}, { document: undefined, window: undefined });
    assert.doesNotThrow(stop);
  });
});
