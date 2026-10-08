import { z } from 'zod';

/**
 * Convert a tool's `inputSchema` into a plain, structuredClone-safe JSON Schema.
 *
 * Tool results are structuredClone'd by Mastra's AgentController
 * (SessionRunEngine.emitMessagePart, @mastra/core >= 1.75). A raw Zod v4 schema
 * carries bound functions and throws
 * `DataCloneError: function () { [native code] } could not be cloned.`,
 * which fails the whole harness heartbeat.
 */
export function serializeToolInputSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;

  // Zod v4 (createTool / MCP tools converted to Zod)
  if ('_zod' in schema) {
    try {
      return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<
        string,
        unknown
      >;
    } catch {
      // fall through to the plain-data path
    }
  }

  // AI SDK `jsonSchema()` wrapper: { jsonSchema, validate() }
  const candidate =
    'jsonSchema' in schema && schema.jsonSchema && typeof schema.jsonSchema === 'object'
      ? schema.jsonSchema
      : schema;

  try {
    // Drops functions/symbols; throws on cycles/BigInt.
    const plain = JSON.parse(JSON.stringify(candidate)) as unknown;
    return plain && typeof plain === 'object' ? (plain as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
