/**
 * S297-S3: atomic per-key writes against `agents.runtime_config` (jsonb).
 *
 * Every runtimeConfig member (heartbeat, model, avatar, secrets, …) lives in one jsonb column.
 * The historical updaters read the whole document, edit one key in JS, and write the whole
 * document back, so two concurrent saves (e.g. avatar + heartbeat) could lose one write: the
 * second writer's snapshot never contained the first writer's key.
 *
 * `updateAgentRuntimeConfigKeys` writes only the keys the caller owns, in ONE statement:
 * `(runtime_config - 'clearedKey' …) || jsonb_build_object('setKey', CAST(? AS jsonb), …)`.
 * Concurrent writes to *other* keys are never dropped, whatever the caller read first.
 *
 * S306-S3: object-valued keys whose members are edited independently (`model`, `secrets`,
 * `budget`, `heartbeat`, `timeout`) go through `merge` — a nested per-LEAF write. The caller
 * passes only the leaves it changed (`runtimeConfigLeafOps(snapshot, next)` computes them);
 * Postgres applies them onto the LIVE sub-object in the same single statement
 * (`jsonb_set(doc, '{key}', (doc->'key' - 'clearedLeaf') || jsonb_build_object(...))`), so two
 * concurrent edits to *different leaves* of one key both survive. Same-leaf races stay
 * last-writer-wins, as for top-level keys.
 *
 * Stored shapes stay byte-identical to the whole-object writes they replace: set values are
 * bound as `JSON.stringify` text cast to jsonb (exactly what the driver used to send for the
 * column), and clears use the `-` operator, which removes the key — the same shape a dropped
 * `undefined` member produced through `JSON.stringify`.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { db } from './client';
import * as schema from './schema/index';
import { agents, type Agent } from './schema/agents';
import type { RuntimeConfigLeafOps } from '@tourbillon/shared/runtime-config-leaf-ops';

export { runtimeConfigLeafOps, type RuntimeConfigLeafOps } from '@tourbillon/shared/runtime-config-leaf-ops';

/** Any Drizzle Postgres database over this schema (the app pool, or an in-memory one in tests). */
export type AgentRuntimeConfigDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defaultDb = db as unknown as AgentRuntimeConfigDb;

export interface RuntimeConfigKeyOps {
  /** Top-level runtimeConfig keys to set to these (JSON-serialisable) values. */
  set?: Record<string, unknown>;
  /** Top-level runtimeConfig keys to remove from the jsonb document. */
  clear?: readonly string[];
  /**
   * S306-S3: object-valued top-level keys to merge into leaf-by-leaf (nested jsonb merge onto
   * the live sub-object; a non-object live value is treated as `{}`). A key may appear here
   * with no leaf ops — that only materialises it (`{}` when absent) without touching leaves.
   */
  merge?: Record<string, RuntimeConfigLeafOps>;
}

function validateSetClear(
  scope: string,
  set: Record<string, unknown>,
  clear: readonly string[],
): void {
  const setKeys = new Set<string>();
  for (const [key, value] of Object.entries(set)) {
    if (!key) throw new Error(`${scope}: empty key name`);
    if (value === undefined) {
      throw new Error(`${scope}: key "${key}" has undefined value — pass it in \`clear\` instead`);
    }
    setKeys.add(key);
  }
  const clearSeen = new Set<string>();
  for (const key of clear) {
    if (!key) throw new Error(`${scope}: empty key name`);
    if (setKeys.has(key)) throw new Error(`${scope}: key "${key}" is both set and cleared`);
    if (clearSeen.has(key)) throw new Error(`${scope}: duplicate clear for "${key}"`);
    clearSeen.add(key);
  }
}

function buildObjectPairs(scope: string, entries: Array<[string, unknown]>): SQL {
  const pairs = entries.map(([key, value]) => {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Error(`${scope}: key "${key}" is not JSON-serialisable`);
    }
    return sql`cast(${key} as text), cast(${json} as jsonb)`;
  });
  return sql`jsonb_build_object(${sql.join(pairs, sql`, `)})`;
}

/**
 * Builds the single-statement jsonb expression: clears first (`-`), then the set-merge (`||`),
 * then each nested leaf merge (S306-S3) onto the live sub-object.
 */
export function buildRuntimeConfigKeyMerge(ops: RuntimeConfigKeyOps): SQL {
  const setEntries = Object.entries(ops.set ?? {});
  const clears = [...(ops.clear ?? [])];
  const mergeEntries = Object.entries(ops.merge ?? {});
  validateSetClear('runtimeConfig key ops', ops.set ?? {}, clears);
  const topLevel = new Set<string>([...setEntries.map(([k]) => k), ...clears]);
  for (const [key, leafOps] of mergeEntries) {
    if (!key) throw new Error('runtimeConfig key ops: empty key name');
    if (topLevel.has(key)) {
      throw new Error(`runtimeConfig key ops: key "${key}" is both merged and set/cleared`);
    }
    validateSetClear(`runtimeConfig key ops (merge "${key}")`, leafOps.set ?? {}, leafOps.clear ?? []);
  }
  if (setEntries.length === 0 && clears.length === 0 && mergeEntries.length === 0) {
    throw new Error('runtimeConfig key ops: nothing to do — pass at least one set, clear or merge');
  }

  // coalesce() guards the (schema-defaulted, so theoretically unreachable) NULL column:
  // jsonb operators propagate NULL, and callers expect `{}` semantics.
  const live: SQL = sql`coalesce(${agents.runtimeConfig}, '{}'::jsonb)`;
  let expr: SQL = live;
  for (const key of clears) expr = sql`(${expr} - ${key}::text)`;
  if (setEntries.length > 0) {
    expr = sql`(${expr}) || ${buildObjectPairs('runtimeConfig key ops', setEntries)}`;
  }
  for (const [key, leafOps] of mergeEntries) {
    // The sub-object is read from the LIVE column (not from `expr`): merge keys are disjoint
    // from set/clear keys and from each other, so the value is the same and the expression
    // stays linear in size. A non-object live value (absent, null, scalar, array) merges as {}.
    let inner: SQL = sql`(case when jsonb_typeof(${live} -> ${key}::text) = 'object' then ${live} -> ${key}::text else '{}'::jsonb end)`;
    for (const leaf of leafOps.clear ?? []) inner = sql`(${inner} - ${leaf}::text)`;
    const leafSets = Object.entries(leafOps.set ?? {});
    if (leafSets.length > 0) {
      inner = sql`(${inner} || ${buildObjectPairs(`runtimeConfig key ops (merge "${key}")`, leafSets)})`;
    }
    expr = leafOps.dropIfEmpty
      ? sql`((${expr}) - ${key}::text) || (case when ${inner} = '{}'::jsonb then '{}'::jsonb else jsonb_build_object(cast(${key} as text), ${inner}) end)`
      : sql`jsonb_set(${expr}, array[cast(${key} as text)], ${inner}, true)`;
  }
  return expr;
}

/**
 * Atomically sets/clears/leaf-merges the given top-level `runtimeConfig` keys on one agent row, together
 * with any extra plain column values, in a single UPDATE. Resolves to the updated row, or
 * null when the row is gone (deleted concurrently between the caller's read and this write).
 */
export async function updateAgentRuntimeConfigKeys(
  agentId: string,
  ops: RuntimeConfigKeyOps,
  extraSet: Record<string, unknown> = {},
  database: AgentRuntimeConfigDb = defaultDb,
): Promise<Agent | null> {
  const runtimeConfig = buildRuntimeConfigKeyMerge(ops);
  const [updated] = await database
    .update(agents)
    .set({ ...extraSet, runtimeConfig })
    .where(eq(agents.id, agentId))
    .returning();
  return updated ?? null;
}
