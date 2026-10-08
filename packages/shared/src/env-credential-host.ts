/**
 * LLM API keys from the server environment (LLM_API_KEY, OPENAI_API_KEY, LM_STUDIO_API_KEY, …)
 * are only attached to requests for the host they were configured for: the env base URL of that
 * provider kind, or the provider's built-in default when no env base URL is set.
 *
 * An agent with no LLM provider row falls back to the env config; when its
 * `adapterConfig.baseURL` points somewhere else, the env key is not attached and resolution
 * fails with {@link EnvCredentialHostError} (409) instead.
 *
 * Host rule: the same one used for provider rows (sameCredentialBoundary in
 * apps/web/lib/provider-safety.ts, used for redirects and base URL changes): same hostname
 * (case-insensitive; IDN compared in its ASCII/punycode form, as the URL parser normalises it),
 * same port (default ports normalised, so `https://h` and `https://h:443` match), same scheme,
 * except that http → https on the same hostname with default ports is allowed. A base URL that
 * can't be parsed never matches. In addition, a request base URL carrying a username or password
 * (user:pass@host) never receives an env key.
 */

export type EnvCredentialHostErrorCode =
  | 'llm_provider_base_url_host_mismatch'
  | 'llm_provider_base_url_credentials';

/**
 * Same shape as the web app's ProviderConfigError (name, 409 status, `llm_provider_*` code), so
 * the existing 409 handling for provider config errors applies to it as well.
 */
export class EnvCredentialHostError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly code: EnvCredentialHostErrorCode,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Structural check, so it also works across bundles holding separate copies of this module. */
export function isEnvCredentialHostError(err: unknown): err is EnvCredentialHostError {
  if (err instanceof EnvCredentialHostError) return true;
  if (!(err instanceof Error) || err.name !== 'ProviderConfigError') return false;
  const e = err as Error & { code?: unknown; status?: unknown };
  return (
    e.status === 409 &&
    (e.code === 'llm_provider_base_url_host_mismatch' || e.code === 'llm_provider_base_url_credentials')
  );
}

function parseURL(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/**
 * True when a key configured for `configuredBaseURL` may be sent to `requestBaseURL` (see the
 * host rule above).
 */
export function envCredentialHostMatches(configuredBaseURL: string, requestBaseURL: string): boolean {
  const a = parseURL(configuredBaseURL);
  const b = parseURL(requestBaseURL);
  if (!a || !b) return false;
  if (b.username || b.password) return false;
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if (a.protocol === b.protocol) return a.port === b.port;
  return a.protocol === 'http:' && b.protocol === 'https:' && a.port === '' && b.port === '';
}

/** `scheme://host[:port]` for messages: never userinfo, path or query. */
function originForMessage(raw: string): string {
  const u = parseURL(raw);
  if (!u || !/^https?:$/.test(u.protocol)) return raw.trim() ? 'an unparseable URL' : 'no base URL';
  return `${u.protocol}//${u.host}`;
}

/**
 * The error to raise when an env key would be sent to `requestBaseURL`, or null when it may be.
 * Messages name the provider, the env variable and both hosts; never the key itself.
 */
export function envCredentialHostRefusal(input: {
  providerLabel: string;
  keyEnvName: string;
  configuredBaseURL: string;
  requestBaseURL: string;
}): EnvCredentialHostError | null {
  const { providerLabel, keyEnvName, configuredBaseURL, requestBaseURL } = input;
  if (envCredentialHostMatches(configuredBaseURL, requestBaseURL)) return null;
  const request = parseURL(requestBaseURL);
  if (request && (request.username || request.password)) {
    return new EnvCredentialHostError(
      `The agent's base URL contains a username or password (user:pass@host); refusing to attach ` +
        `the ${providerLabel} API key from the server environment (${keyEnvName}). Remove the ` +
        'credentials from the URL.',
      'llm_provider_base_url_credentials',
    );
  }
  return new EnvCredentialHostError(
    `The agent's base URL (${originForMessage(requestBaseURL)}) is on a different host from the ` +
      `${providerLabel} base URL configured in the server environment ` +
      `(expected ${originForMessage(configuredBaseURL)}); refusing to attach the API key from ` +
      `${keyEnvName} there. Remove the agent's base URL override, give the agent its own API key, ` +
      'or add an LLM provider for that host in Settings → LLM Providers.',
    'llm_provider_base_url_host_mismatch',
  );
}

export interface EnvCredentialResolveOptions {
  /**
   * What to do when an env API key would go to a different host:
   * - 'throw' (default): raise {@link EnvCredentialHostError}. Use for anything that calls the
   *   provider (runs, chat, model listing).
   * - 'omit-key': resolve without the key (apiKey ''). Display-only callers (agent pages) that
   *   show the provider, endpoint and model and never call it.
   */
  onEnvCredentialHostMismatch?: 'throw' | 'omit-key';
}
