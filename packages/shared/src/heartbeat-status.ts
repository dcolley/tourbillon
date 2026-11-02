/**
 * #299 S299-S2: the `heartbeat_runs.status` literal union lives here (previously inline in
 * packages/db/src/schema/heartbeat-runs.ts) so @tourbillon/shared can define
 * TERMINAL_HEARTBEAT_STATUSES without importing anything from @tourbillon/db. That
 * type-only import plus a declared workspace dependency was the shared→db edge that made
 * the db↔shared workspace pair cyclic (`pnpm install` warned "cyclic workspace
 * dependencies: packages/db, packages/shared"). db now consumes and re-exports this type
 * (`@tourbillon/db/schema` still resolves `HeartbeatStatus`); the members below are
 * byte-identical to the old inline union and the column stays plain `text` — no migration.
 */
export const HEARTBEAT_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'coalesced',
  'skipped',
] as const;

export type HeartbeatStatus = (typeof HEARTBEAT_STATUSES)[number];
