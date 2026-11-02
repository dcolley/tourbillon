/**
 * S298-S3 (#298): the /jobs queue card must not render zero-valued neutral terminal
 * counters (`skipped: 0`, `coalesced: 0`, `cancelled: 0` are pure clutter — some
 * queues can never produce them at all), while core operational counters keep
 * rendering at 0 (0 there is itself the signal).
 *
 * Render test (per the brief): QueueCountBadges — the component page.tsx renders —
 * is rendered with react-dom/server markup (same idiom as components/ui/
 * password-input.test.ts: no DOM library on this repo; tsx compiles JSX with the
 * classic runtime, so React must be on the global before the module loads).
 *
 * Mutant (S298-S1/S3 gate M-d): make CountBadge always render (drop the hide at 0)
 * → the zero-hidden assertions below go RED. Counter-mutant (hide-everything, even
 * waiting/active/completed/failed at 0) is caught by the keep-at-zero assertions.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueueCounts } from '@/lib/jobs';

type Badges = (p: { counts: QueueCounts }) => React.ReactNode;

describe('jobs card: zero-valued neutral counters are hidden (S298-S3, #298)', () => {
  let QueueCountBadges: Badges;

  before(async () => {
    // tsx compiles JSX with the classic runtime (tsconfig jsx: preserve).
    (globalThis as { React?: unknown }).React = React;
    ({ QueueCountBadges } = (await import('./queue-count-badges')) as never);
  });

  const base: QueueCounts = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
    skipped: 0,
    coalesced: 0,
    cancelled: 0,
  };

  it('hides skipped/coalesced/cancelled at 0 but keeps the core counters', () => {
    const html = renderToStaticMarkup(
      React.createElement(QueueCountBadges, { counts: { ...base } }),
    );
    for (const hidden of ['skipped: 0', 'coalesced: 0', 'cancelled: 0']) {
      assert.ok(!html.includes(hidden), `'${hidden}' must not render at zero (S298-S3)`);
    }
    for (const shown of ['waiting: 0', 'active: 0', 'completed: 0', 'failed: 0']) {
      assert.ok(html.includes(shown), `'${shown}' must still render at zero`);
    }
  });

  it('renders skipped/coalesced/cancelled whenever they are non-zero', () => {
    const html = renderToStaticMarkup(
      React.createElement(QueueCountBadges, {
        counts: { ...base, skipped: 2, coalesced: 1, cancelled: 3 },
      }),
    );
    assert.ok(html.includes('skipped: 2'));
    assert.ok(html.includes('coalesced: 1'));
    assert.ok(html.includes('cancelled: 3'));
  });

  it('isZeroOnly queue renders exactly the four core counters', () => {
    const html = renderToStaticMarkup(
      React.createElement(QueueCountBadges, { counts: { ...base } }),
    );
    const badges = html.match(/<span[^>]*>[^<]*: \d+<\/span>/g) ?? [];
    assert.deepEqual(badges?.map((b) => b.replace(/<[^>]+>/g, '')).sort(), [
      'active: 0',
      'completed: 0',
      'failed: 0',
      'waiting: 0',
    ]);
  });
});
