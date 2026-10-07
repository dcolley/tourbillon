import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';
import { collectSecretValueEntries, scrubSecretValues } from '@tourbillon/shared';

/**
 * #100: Process-wide registry of known secret values (agent `runtimeConfig.secrets`, MCP
 * credentials, Tavily/SearXNG keys from agent runtime config and company settings).
 *
 * Populated at run start (createHeartbeatRuntimeContext → the running agent; wake-runner →
 * every agent in the company + company settings). Used to scrub those values out of
 * observability data before it is persisted (Postgres) or exported (Phoenix/Arize).
 */
type Registry = Map<string, Array<[string, string]>>;

const REGISTRY_KEY = Symbol.for('tourbillon.knownSecretValues');
const globalRegistry = globalThis as unknown as { [REGISTRY_KEY]?: Registry };

function registry(): Registry {
  return (globalRegistry[REGISTRY_KEY] ??= new Map());
}

/**
 * Register (or replace) the secret values for a scope, e.g. `agent:<id>` or `company:<id>`.
 * Replacing per scope means rotated values supersede old ones instead of accumulating.
 */
export function registerKnownSecretValues(scope: string, configs: unknown[]): void {
  const entries = configs.flatMap((c) => collectSecretValueEntries(c));
  if (entries.length === 0) {
    registry().delete(scope);
    return;
  }
  registry().set(scope, entries);
}

/** Test hook. */
export function clearKnownSecretValues(): void {
  registry().clear();
}

function allKnownEntries(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entries of registry().values()) out.push(...entries);
  return out;
}

/** Scrub every registered secret value from `value` (deep, copy-on-write). */
export function scrubKnownSecretValues<T>(value: T): T {
  const entries = allKnownEntries();
  return entries.length === 0 ? value : scrubSecretValues(value, entries);
}

/**
 * Span output processor: replaces known secret values with `[REDACTED:<keyName>]` in span
 * name, attributes, metadata, input, output, errorInfo and requestContext. Runs before every
 * exporter (TourbillonPostgresExporter, ArizeExporter). Mutates the span's fields by
 * reassignment (copies), so live tool results / model messages are never altered.
 */
export class SecretValueRedactionProcessor implements SpanOutputProcessor {
  name = 'tourbillon-secret-value-redaction';

  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span;
    const entries = allKnownEntries();
    if (entries.length === 0) return span;
    const s = span as unknown as Record<string, unknown>;
    for (const field of ['name', 'attributes', 'metadata', 'input', 'output', 'errorInfo', 'requestContext']) {
      if (s[field] !== undefined) s[field] = scrubSecretValues(s[field], entries);
    }
    return span;
  }

  async shutdown(): Promise<void> {}
}
