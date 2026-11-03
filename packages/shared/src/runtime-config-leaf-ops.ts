/**
 * S306-S3: leaf-level ops for object-valued runtimeConfig keys (`model`, `secrets`, `budget`,
 * `heartbeat`, `timeout`). Pure — the SQL that applies them lives in
 * `@tourbillon/db` (`updateAgentRuntimeConfigKeys({ merge })`). Kept in shared so callers that
 * mock `@tourbillon/db` in tests still compute the same ops.
 */
/** Leaf ops applied onto the LIVE value of one object-valued runtimeConfig key. */
export interface RuntimeConfigLeafOps {
  /** Leaves (direct members of the sub-object) to set to these JSON-serialisable values. */
  set?: Record<string, unknown>;
  /** Leaves to remove from the sub-object. */
  clear?: readonly string[];
  /**
   * When true, the key itself is removed if the merged sub-object ends up `{}` (evaluated on
   * the live document, in the statement) — the shape a whole-object write of an emptied value
   * produced. When false (default) the key is materialised, as `{}` at minimum.
   */
  dropIfEmpty?: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * S306-S3: the leaf ops that turn `prev` (the caller's snapshot of one sub-object) into `next`
 * (the value it computed): leaves whose JSON value changed are set, leaves present in `prev`
 * but absent / `undefined` in `next` are cleared. Unchanged leaves are NOT written, so a
 * concurrent writer's edit to them survives the merge.
 */
export function runtimeConfigLeafOps(
  prev: unknown,
  next: unknown,
  options: { dropIfEmpty?: boolean } = {},
): RuntimeConfigLeafOps {
  const before = asPlainObject(prev);
  const after = asPlainObject(next);
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [leaf, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (!(leaf in before) || before[leaf] === undefined || stableJson(before[leaf]) !== stableJson(value)) {
      set[leaf] = value;
    }
  }
  for (const [leaf, value] of Object.entries(before)) {
    if (value === undefined) continue;
    if (!(leaf in after) || after[leaf] === undefined) clear.push(leaf);
  }
  const ops: RuntimeConfigLeafOps = {};
  if (Object.keys(set).length > 0) ops.set = set;
  if (clear.length > 0) ops.clear = clear;
  if (options.dropIfEmpty) ops.dropIfEmpty = true;
  return ops;
}

