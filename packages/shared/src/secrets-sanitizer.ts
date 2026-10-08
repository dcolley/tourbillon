import type { AgentRuntimeConfig } from './types';

/**
 * AC-B1.2: Sanitize agent secrets from runtime config before logging, UI display, or observability.
 * Secrets must never appear in prompts, observability logs, or issue comments.
 * 
 * Replaces secret values with key count (e.g., "{ keys: ['KEY1', 'KEY2'] }") or removes entirely.
 */
export function sanitizeAgentSecrets<T extends { runtimeConfig?: unknown }>(
  agent: T,
  options: { showKeys?: boolean } = {}
): T {
  if (!agent.runtimeConfig || typeof agent.runtimeConfig !== 'object') {
    return agent;
  }

  const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
  
  if (!runtimeConfig.secrets || typeof runtimeConfig.secrets !== 'object') {
    return agent;
  }

  const sanitized: AgentRuntimeConfig = {
    ...runtimeConfig,
    secrets: undefined, // Never include secret values
  };

  if (options.showKeys) {
    // For UI: show only key names, never values
    return {
      ...agent,
      runtimeConfig: {
        ...sanitized,
        // TypeScript doesn't like mixing types, but this is intentional for UI
        __secretKeys: Object.keys(runtimeConfig.secrets),
      } as unknown as typeof agent.runtimeConfig,
    };
  }

  // For logs/observability: completely remove secrets field
  return {
    ...agent,
    runtimeConfig: sanitized as typeof agent.runtimeConfig,
  };
}

/**
 * AC-B1.2: Sanitize runtime config in place (mutating).
 * Use when you need to strip secrets from an existing object reference.
 */
export function stripSecretsInPlace(runtimeConfig: AgentRuntimeConfig): void {
  if (runtimeConfig.secrets) {
    delete runtimeConfig.secrets;
  }
}

/**
 * AC-B1.2: Check if a string contains potential secret patterns.
 * Used to prevent accidental logging of secret values.
 */
export function containsPotentialSecret(text: string, secrets?: Record<string, string>): boolean {
  if (!secrets || typeof secrets !== 'object') {
    return false;
  }

  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value.length > 0 && text.includes(value)) {
      return true;
    }
  }

  return false;
}

/** Placeholder returned instead of a secret value in agent read paths (#100). */
export const REDACTED_SECRET_PLACEHOLDER = '[redacted]';

/**
 * Minimum length for value-based scrubbing (#100). Shorter values ("true", "1234", "admin")
 * would cause false-positive redactions across unrelated text; they are still covered by the
 * structural `runtimeConfig` redaction, just not by free-text value matching.
 */
export const SECRET_VALUE_MIN_LENGTH = 8;

/** Credential-bearing scalar fields on AgentRuntimeConfig / CompanySettings besides `secrets`. */
const CREDENTIAL_SCALAR_FIELDS = ['tavilyApiKey', 'searxngApiKey'] as const;
/** Credential-bearing maps (keys are safe names, values are secrets). */
const CREDENTIAL_MAP_FIELDS = ['secrets', 'mcpCredentials'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * #100: Return a copy of a runtime config whose `secrets` / `mcpCredentials` keep key names
 * only (each value replaced with `[redacted]`) and whose API-key scalars are replaced too.
 * Non-object input is returned unchanged.
 */
export function redactRuntimeConfigSecrets<T>(runtimeConfig: T): T {
  if (!isPlainObject(runtimeConfig)) return runtimeConfig;
  let out: Record<string, unknown> | null = null;
  const copy = () => (out ??= { ...runtimeConfig });

  for (const field of CREDENTIAL_MAP_FIELDS) {
    const map = runtimeConfig[field];
    if (isPlainObject(map)) {
      copy()[field] = Object.fromEntries(Object.keys(map).map((k) => [k, REDACTED_SECRET_PLACEHOLDER]));
    }
  }
  for (const field of CREDENTIAL_SCALAR_FIELDS) {
    if (typeof runtimeConfig[field] === 'string' && runtimeConfig[field]) {
      copy()[field] = REDACTED_SECRET_PLACEHOLDER;
    }
  }
  return (out ?? runtimeConfig) as T;
}

/** #100: Redact `runtimeConfig` secrets on a single agent-shaped object. */
export function redactAgentRuntimeSecrets<T extends { runtimeConfig?: unknown }>(agent: T): T {
  if (!agent || typeof agent !== 'object' || !('runtimeConfig' in agent)) return agent;
  const runtimeConfig = redactRuntimeConfigSecrets(agent.runtimeConfig);
  return runtimeConfig === agent.runtimeConfig ? agent : { ...agent, runtimeConfig };
}

/**
 * #100: Deep-walk any JSON-like value (tool result, API payload) and redact every
 * `runtimeConfig` object found, at any depth. Copy-on-write: the input is never mutated and
 * unchanged branches keep their identity. Non-plain objects (Date, class instances) pass through.
 */
export function redactAgentSecretsDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactAgentSecretsDeep(item, seen);
      if (r !== item) changed = true;
      return r;
    });
    return (changed ? next : value) as T;
  }
  if (!isPlainObject(value)) return value;

  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value)) {
    const next =
      key === 'runtimeConfig'
        ? redactAgentSecretsDeep(redactRuntimeConfigSecrets(child), seen)
        : redactAgentSecretsDeep(child, seen);
    if (next !== child) (out ??= { ...value })[key] = next;
  }
  return (out ?? value) as T;
}

/**
 * #100: Collect `[label, value]` pairs for every secret value held in an agent runtime config
 * or company settings object (`secrets.*`, `mcpCredentials.*`, Tavily/SearXNG/HITLy API keys).
 */
export function collectSecretValueEntries(config: unknown): Array<[string, string]> {
  if (!isPlainObject(config)) return [];
  const entries: Array<[string, string]> = [];
  const secrets = config.secrets;
  if (isPlainObject(secrets)) {
    for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string') entries.push([k, v]);
  }
  const mcp = config.mcpCredentials;
  if (isPlainObject(mcp)) {
    for (const [k, v] of Object.entries(mcp)) if (typeof v === 'string') entries.push([`mcpCredentials.${k}`, v]);
  }
  for (const field of CREDENTIAL_SCALAR_FIELDS) {
    const v = config[field];
    if (typeof v === 'string') entries.push([field, v]);
  }
  const hitly = config.hitlyGate;
  if (isPlainObject(hitly) && typeof hitly.apiKey === 'string') entries.push(['hitlyGate.apiKey', hitly.apiKey]);
  return entries.filter(([, v]) => v.trim().length >= SECRET_VALUE_MIN_LENGTH);
}

/**
 * #100: Replace every occurrence of a known secret value inside strings of `value` (deep,
 * copy-on-write) with `[REDACTED:<keyName>]`. Values shorter than SECRET_VALUE_MIN_LENGTH
 * are ignored. JSON-escaped forms of each value are matched as well.
 */
export function scrubSecretValues<T>(value: T, entries: Iterable<[string, string]>): T {
  const needles: Array<[string, string]> = [];
  for (const [label, raw] of entries) {
    if (typeof raw !== 'string' || raw.trim().length < SECRET_VALUE_MIN_LENGTH) continue;
    const marker = `[REDACTED:${label}]`;
    needles.push([raw, marker]);
    const escaped = JSON.stringify(raw).slice(1, -1);
    if (escaped !== raw) needles.push([escaped, marker]);
  }
  if (needles.length === 0) return value;
  // Longest first so a secret that contains another is replaced whole.
  needles.sort((a, b) => b[0].length - a[0].length);

  const scrubString = (s: string): string => {
    let out = s;
    for (const [needle, marker] of needles) {
      if (out.includes(needle)) out = out.split(needle).join(marker);
    }
    return out;
  };

  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubString(v);
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map((item) => {
        const r = walk(item);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : v;
    }
    if (!isPlainObject(v)) return v;
    let out: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(v)) {
      const next = walk(child);
      if (next !== child) (out ??= { ...v })[key] = next;
    }
    return out ?? v;
  };
  return walk(value) as T;
}
