import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { getMonorepoRoot, resolveDataPath } from './monorepo-root';
import type { McpServerDefinition } from './mcp-types';

const ENV_INTERPOLATION = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const mcpJsonServerSchema = z
  .object({
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.url && !value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP server entry requires either url (HTTP) or command (stdio)',
      });
    }
  });

const mcpJsonFileSchema = z.object({
  mcpServers: z.record(z.string().min(1), mcpJsonServerSchema),
});

export type McpJsonFile = z.infer<typeof mcpJsonFileSchema>;

/** Resolve `${env:NAME}` placeholders; missing env vars become empty string. */
export function interpolateEnvPlaceholders(value: string): string {
  return value.replace(ENV_INTERPOLATION, (_match, name: string) => process.env[name] ?? '');
}

function interpolateRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    next[key] = interpolateEnvPlaceholders(raw);
  }
  return next;
}

function labelFromServerId(id: string): string {
  const base = id.replace(/-mcp$/i, '');
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Default `<repo>/mcp.json`, or `TOURBILLON_MCP_CONFIG` (absolute or repo-relative). */
export function resolveMcpConfigPath(): string {
  return resolveDataPath(process.env.TOURBILLON_MCP_CONFIG, 'mcp.json');
}

export function mcpJsonEntryToDefinition(
  id: string,
  entry: z.infer<typeof mcpJsonServerSchema>,
): McpServerDefinition {
  if (entry.url) {
    return {
      id,
      label: labelFromServerId(id),
      transport: 'http',
      url: interpolateEnvPlaceholders(entry.url),
      headers: interpolateRecord(entry.headers),
      source: 'file',
    };
  }

  return {
    id,
    label: labelFromServerId(id),
    transport: 'stdio',
    command: entry.command ? interpolateEnvPlaceholders(entry.command) : undefined,
    args: entry.args?.map((arg) => interpolateEnvPlaceholders(arg)),
    env: interpolateRecord(entry.env),
    source: 'file',
  };
}

/**
 * Load Cursor/Claude-compatible mcp.json and return server definitions.
 * Missing file → []; invalid JSON/schema → warn and return [].
 */
export function loadMcpJsonConfig(configPath?: string): McpServerDefinition[] {
  const filePath = configPath ?? resolveMcpConfigPath();
  if (!existsSync(filePath)) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mcp-config] Failed to parse ${filePath}: ${message}`);
    return [];
  }

  const parsed = mcpJsonFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[mcp-config] Invalid mcp.json at ${filePath}: ${parsed.error.message}`);
    return [];
  }

  const definitions: McpServerDefinition[] = [];
  for (const [id, entry] of Object.entries(parsed.data.mcpServers)) {
    try {
      definitions.push(mcpJsonEntryToDefinition(id, entry));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp-config] Skipping server "${id}": ${message}`);
    }
  }

  return definitions;
}

/** Absolute path helper for tests/docs (does not require the file to exist). */
export function defaultMcpConfigPath(): string {
  return path.join(getMonorepoRoot(), 'mcp.json');
}
