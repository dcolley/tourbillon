import type { AgentModelSettings } from './model-settings';

export const DEFAULT_HEARTBEAT_CONTEXT_TOKEN_LIMIT = 120_000;
export const MIN_CONTEXT_TOKEN_LIMIT = 8_000;
export const DEFAULT_OUTPUT_TOKEN_RESERVE = 2_048;
export const DURABLE_TOOL_SCHEMA_RESERVE = 8_000;
export const HARNESS_TOOL_SCHEMA_RESERVE = 16_000;
export const DEFAULT_OM_OBSERVATION_TOKENS = 30_000;
export const DEFAULT_OM_REFLECTION_TOKENS = 40_000;

export type ContextBudgetKind = 'durable' | 'harness' | 'chat';

export interface ContextBudget {
  /** Configured model window, or null when falling back to the env limiter. */
  contextTokens: number | null;
  outputReserve: number;
  limiterLimit: number;
  observationThreshold: number;
  reflectionThreshold: number;
}

/**
 * Context budget snapshot persisted before streaming for diagnostics.
 * Helps identify when tool schemas exceed reserves and cause provider rejections.
 */
export interface ContextBudgetSnapshot {
  kind: ContextBudgetKind;
  maxContextTokens: number | null;
  limiterLimit: number;
  outputReserve: number;
  toolReserve: number;
  /** Rough estimate of actual tool schema tokens (JSON length * 0.25). */
  estimatedToolSchemaTokens: number;
  /** Rough estimate of system prompt tokens (length * 0.25). */
  estimatedSystemTokens: number;
}

export function toolSchemaReserveForKind(kind: ContextBudgetKind): number {
  return kind === 'harness' ? HARNESS_TOOL_SCHEMA_RESERVE : DURABLE_TOOL_SCHEMA_RESERVE;
}

export function resolveEnvContextTokenLimit(
  raw = process.env.HEARTBEAT_CONTEXT_TOKEN_LIMIT,
): number {
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= MIN_CONTEXT_TOKEN_LIMIT) return n;
  }
  return DEFAULT_HEARTBEAT_CONTEXT_TOKEN_LIMIT;
}

export function resolveOutputReserve(maxOutputTokens?: number): number {
  if (maxOutputTokens === undefined) return DEFAULT_OUTPUT_TOKEN_RESERVE;
  return Math.max(maxOutputTokens, DEFAULT_OUTPUT_TOKEN_RESERVE);
}

/**
 * When a context window is known and the agent/provider did not set output
 * length, reserve a default so local servers are not asked for 0 completion tokens.
 */
export function applyContextWindowDefaults(
  settings: AgentModelSettings,
): AgentModelSettings {
  if (!settings.maxContextTokens || settings.maxOutputTokens !== undefined) {
    return settings;
  }
  return { ...settings, maxOutputTokens: DEFAULT_OUTPUT_TOKEN_RESERVE };
}

export function resolveOmThresholds(limiterLimit: number): {
  observationThreshold: number;
  reflectionThreshold: number;
} {
  const observationThreshold = Math.min(
    DEFAULT_OM_OBSERVATION_TOKENS,
    Math.max(MIN_CONTEXT_TOKEN_LIMIT, Math.floor(limiterLimit * 0.25)),
  );
  const reflectionThreshold = Math.min(
    DEFAULT_OM_REFLECTION_TOKENS,
    Math.max(observationThreshold + 4_000, Math.floor(limiterLimit * 0.35)),
  );
  return { observationThreshold, reflectionThreshold };
}

export function resolveContextBudget(input: {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  kind: ContextBudgetKind;
  envLimit?: number;
}): ContextBudget {
  const outputReserve = resolveOutputReserve(input.maxOutputTokens);
  const toolReserve = toolSchemaReserveForKind(input.kind);
  const envLimit = input.envLimit ?? resolveEnvContextTokenLimit();

  if (input.maxContextTokens && input.maxContextTokens >= MIN_CONTEXT_TOKEN_LIMIT) {
    const limiterLimit = Math.max(
      MIN_CONTEXT_TOKEN_LIMIT,
      input.maxContextTokens - outputReserve - toolReserve,
    );
    return {
      contextTokens: input.maxContextTokens,
      outputReserve,
      limiterLimit,
      ...resolveOmThresholds(limiterLimit),
    };
  }

  return {
    contextTokens: null,
    outputReserve,
    limiterLimit: envLimit,
    observationThreshold: DEFAULT_OM_OBSERVATION_TOKENS,
    reflectionThreshold: DEFAULT_OM_REFLECTION_TOKENS,
  };
}

/** Stateless wakes must not resume a prior assignment (or any unmatched) run. */
export function isResumableWakeMatch(
  wakeTaskId?: string,
  snapshotTaskId?: string,
): boolean {
  return Boolean(wakeTaskId) && wakeTaskId === snapshotTaskId;
}

/**
 * Rough token estimate for debugging: char count * 0.25.
 * Not accurate but sufficient for diagnosing context budget overflows.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.25);
}

/**
 * Extract JSON schemas from Mastra tool objects for token estimation.
 * Mastra tools created with createTool have internal structure; we need the
 * JSON Schema representation that the provider actually sees.
 */
function extractToolJsonSchemas(tools: unknown[]): unknown[] {
  const schemas: unknown[] = [];
  
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    
    const toolObj = tool as Record<string, unknown>;
    
    // Try to extract schema from various possible locations
    // Mastra tools have different internal structures depending on version
    if ('schema' in toolObj && toolObj.schema) {
      schemas.push(toolObj.schema);
    } else if ('inputSchema' in toolObj && toolObj.inputSchema) {
      schemas.push(toolObj.inputSchema);
    } else if ('parameters' in toolObj && toolObj.parameters) {
      // Already in JSON Schema format
      schemas.push({
        name: toolObj.name,
        description: toolObj.description,
        parameters: toolObj.parameters,
      });
    } else {
      // Fallback: try to create a minimal schema representation
      schemas.push({
        name: toolObj.name ?? 'unknown',
        description: toolObj.description ?? '',
      });
    }
  }
  
  return schemas;
}

/**
 * Create a context budget snapshot for diagnostics.
 * Includes actual tool schema token estimate and system prompt size.
 */
export function createContextBudgetSnapshot(input: {
  budget: ContextBudget;
  kind: ContextBudgetKind;
  toolSchemas?: unknown[];
  systemPrompt?: string;
}): ContextBudgetSnapshot {
  const toolReserve = toolSchemaReserveForKind(input.kind);
  
  let estimatedToolSchemaTokens = 0;
  if (input.toolSchemas && input.toolSchemas.length > 0) {
    try {
      // Extract JSON schemas from tool objects (not the createTool wrappers)
      const schemas = extractToolJsonSchemas(input.toolSchemas);
      const serialized = JSON.stringify(schemas);
      estimatedToolSchemaTokens = estimateTokens(serialized);
    } catch {
      estimatedToolSchemaTokens = 0;
    }
  }

  const estimatedSystemTokens = input.systemPrompt 
    ? estimateTokens(input.systemPrompt) 
    : 0;

  return {
    kind: input.kind,
    maxContextTokens: input.budget.contextTokens,
    limiterLimit: input.budget.limiterLimit,
    outputReserve: input.budget.outputReserve,
    toolReserve,
    estimatedToolSchemaTokens,
    estimatedSystemTokens,
  };
}
