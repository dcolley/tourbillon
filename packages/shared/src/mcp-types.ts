export type McpTransport = 'http' | 'stdio';

export interface McpServerAuthDefinition {
  envVar: string;
  optional?: boolean;
  header?: string;
  prefix?: string;
}

export interface McpServerDefinition {
  id: string;
  label: string;
  toolsetId?: string;
  transport: McpTransport;
  url?: string;
  urlEnvVar?: string;
  /** Extra HTTP headers from mcp.json (after ${env:} interpolation). */
  headers?: Record<string, string>;
  auth?: McpServerAuthDefinition;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  toolWhitelist?: string[];
  toolBlacklist?: string[];
  /** builtin = code catalog; file = loaded from mcp.json (file overrides same id). */
  source?: 'builtin' | 'file';
}
