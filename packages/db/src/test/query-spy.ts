/**
 * Shared test helper (#213 S6c): the driver-boundary query spy, previously copy-pasted in
 * chat-task-runner-softs.test.ts, chat-task-queries.test.ts and the scheduler's
 * task-runner-208-softs.test.ts (which reaches this file through the '@tourbillon/db/test/query-spy'
 * export — it loads PGlite itself via createRequire, so it needs no client types from here).
 *
 * Records every (sql, params) pair drizzle hands to `client.query` from here on — the
 * driver-boundary truth for what actually binds, PGlite leniency included. The target is
 * typed STRUCTURALLY (only `query` is spied) so both the db suites' PGlite and the
 * scheduler's createRequire-loaded client satisfy it without either side importing the
 * other's client class.
 */
export interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/** Minimal structural shape of a drizzle-PGlite client. */
export interface QuerySpyTarget {
  query(sql: string, params?: unknown[], config?: unknown): Promise<unknown>;
}

/** Install the spy on `client` and return the (live) capture log. */
export function spyQueries(client: QuerySpyTarget): CapturedQuery[] {
  const captured: CapturedQuery[] = [];
  const original = client.query.bind(client);
  client.query = (sqlText: string, params?: unknown[], config?: unknown) => {
    captured.push({ sql: String(sqlText), params: params ?? [] });
    return original(sqlText, params, config);
  };
  return captured;
}
