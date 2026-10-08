import { createHash } from 'node:crypto';

/**
 * Canonical JSON for tool-call args, used by the repeated-tool loop breaker.
 *
 * - Object keys are sorted at every depth.
 * - Object properties whose value is `undefined` (or a function/symbol) are dropped,
 *   so `{ a: 1, b: undefined }` and `{ a: 1 }` are the same call.
 * - Array holes / `undefined` entries become `null` (same as JSON.stringify).
 * - Values with `toJSON` (e.g. Date) are serialised via `toJSON`, bigint as a string.
 * - Circular references serialise as the string "[Circular]" instead of throwing.
 * - A top-level `undefined` (tool called with no args) is "null".
 */
export function canonicalToolArgsJson(args: unknown): string {
  const stack: object[] = [];

  const walk = (value: unknown): string | undefined => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return undefined;
    }
    if (value === null) return 'null';
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    if (typeof value !== 'object') return JSON.stringify(value);

    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      return walk(withToJson.toJSON());
    }

    if (stack.includes(value)) return JSON.stringify('[Circular]');
    stack.push(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.map((item) => walk(item) ?? 'null').join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = walk(record[key]);
        if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      stack.pop();
    }
  };

  return walk(args) ?? 'null';
}

/** Stable SHA-256 (hex) of the canonical args JSON. */
export function toolArgsHash(args: unknown): string {
  return createHash('sha256').update(canonicalToolArgsJson(args)).digest('hex');
}

/** Loop-breaker key: tool name + stable args hash. */
export function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}:${toolArgsHash(args)}`;
}
