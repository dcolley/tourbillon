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
 * Concurrent writes to *other* keys are never dropped, whatever the caller read first. Writes
 * that still merge *within* one key (e.g. `model`, `secrets`, `budget`) compute the new value
 * from a snapshot read; only whole-key replacement is race-free at this layer.
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

/** Any Drizzle Postgres database over this schema (the app pool, or an in-memory one in tests). */
export type AgentRuntimeConfigDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defaultDb = db as unknown as AgentRuntimeConfigDb;

export interface RuntimeConfigKeyOps {
  /** Top-level runtimeConfig keys to set to these (JSON-serialisable) values. */
  set?: Record<string, unknown>;
  /** Top-level runtimeConfig keys to remove from the jsonb document. */
  clear?: readonly string[];
}

/** Builds the single-statement jsonb expression: clears first (`-`), then the set-merge (`||`). */
export function buildRuntimeConfigKeyMerge(ops: RuntimeConfigKeyOps): SQL {
  const setEntries = Object.entries(ops.set ?? {});
  const clears = [...(ops.clear ?? [])];
  const setKeys = new Set<string>();
  for (const [key, value] of setEntries) {
    if (!key) throw new Error('runtimeConfig key ops: empty key name');
    if (value === undefined) {
      throw new Error(`runtimeConfig key ops: key "${key}" has undefined value — pass it in \`clear\` instead`);
    }
    setKeys.add(key);
  }
  const clearSeen = new Set<string>();
  for (const key of clears) {
    if (!key) throw new Error('runtimeConfig key ops: empty key name');
    if (setKeys.has(key)) {
      throw new Error(`runtimeConfig key ops: key "${key}" is both set and cleared`);
    }
    if (clearSeen.has(key)) throw new Error(`runtimeConfig key ops: duplicate clear for "${key}"`);
    clearSeen.add(key);
  }
  if (setEntries.length === 0 && clears.length === 0) {
    throw new Error('runtimeConfig key ops: nothing to do — pass at least one set or clear');
  }

  // coalesce() guards the (schema-defaulted, so theoretically unreachable) NULL column:
  // jsonb operators propagate NULL, and callers expect `{}` semantics.
  let expr: SQL = sql`coalesce(${agents.runtimeConfig}, '{}'::jsonb)`;
  for (const key of clears) expr = sql`(${expr} - ${key}::text)`;
  if (setEntries.length > 0) {
    const pairs = setEntries.map(([key, value]) => {
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new Error(`runtimeConfig key ops: key "${key}" is not JSON-serialisable`);
      }
      return sql`cast(${key} as text), cast(${json} as jsonb)`;
    });
    expr = sql`(${expr}) || jsonb_build_object(${sql.join(pairs, sql`, `)})`;
  }
  return expr;
}

/**
 * Atomically sets/clears the given top-level `runtimeConfig` keys on one agent row, together
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
