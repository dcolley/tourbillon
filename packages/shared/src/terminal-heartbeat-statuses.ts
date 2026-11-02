import type { HeartbeatStatus } from './heartbeat-status';

/**
 * #295 S295-S1 / S295-S4: the single source of truth for terminal `heartbeat_runs`
 * statuses — a run in one of these states is finished and must never be resurrected or
 * silently re-recorded.
 *
 * Two consumers, previously hand-duplicated (S1: `skipped` was unpinned in
 * packages/db/src/checkout-lock.ts, S4: `skipped`/`coalesced` were missing from the
 * already-terminal guard in packages/scheduler/src/wake-runner.ts's recordHeartbeatFailure):
 *  - db `isStaleCheckoutRun` — a checkout lock held by a terminal run is stale.
 *  - scheduler `recordHeartbeatSkip` and `recordHeartbeatFailure` — a late terminal record
 *    must not overwrite an earlier terminal one (operator kill, pre-flight skip, coalesce).
 *
 * `queued` / `running` are non-terminal by design: the stale-run sweeps and the failure
 * recorder must still be able to settle them.
 */
export const TERMINAL_HEARTBEAT_STATUSES: ReadonlySet<HeartbeatStatus> = new Set<HeartbeatStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'coalesced',
  'skipped',
]);
