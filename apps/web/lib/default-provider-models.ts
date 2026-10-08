/**
 * GET /api/models with no providerId/agentId: list models for the instance's default provider.
 *
 * Resolution order:
 * 1. The provider registry default (`llm_providers.is_default`), the same instance-wide registry
 *    the `?providerId=` path reads (providers are not company-scoped).
 * 2. Only when the registry has no default: the env config (LLM_PROVIDER / *_BASE_URL), and only
 *    if the env actually names a provider or base URL. Built-in localhost defaults don't count.
 * 3. Neither: 409 `llm_provider_not_configured` with a message saying what to set.
 *
 * A base URL with user:pass@ → 409 `llm_provider_base_url_credentials` (no upstream call).
 * Upstream failures get a JSON error that names the provider instead of a bare 502:
 * unreachable (network error/timeout) → 503 `llm_provider_unreachable`;
 * reachable but answered with an error → 502 `llm_provider_error`.
 */
import { NextResponse } from 'next/server';
import {
  resolveModelProviderConfigFromEnv,
  resolveModelProviderConfigFromRecord,
  type ModelProviderConfig,
} from '@tourbillon/shared';
import { envProviderConfigured } from './env-provider';
import { getDefaultLlmProviderRecord } from './llm-providers';
import { listProviderModelsFromConfig } from './model-catalog';
import {
  ProviderConfigError,
  assertNoBaseURLCredentials,
  redactBaseURL,
  redactUrlsInText,
} from './provider-safety';

export { envProviderConfigured };

export type DefaultProviderSource = 'registry' | 'env';

export type DefaultModelsErrorCode =
  | 'llm_provider_not_configured'
  | 'llm_provider_unreachable'
  | 'llm_provider_error'
  | 'llm_provider_base_url_credentials';

/** Network failure or timeout from fetch (as opposed to an HTTP error response). */
export function isUnreachableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  // undici: `TypeError: fetch failed` with the socket error in `cause`.
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function causeDetail(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return err.message;
}

function describeProvider(config: ModelProviderConfig, source: DefaultProviderSource): string {
  const where = `${config.provider} at ${redactBaseURL(config.baseURL)}`;
  return source === 'registry'
    ? `default LLM provider "${config.providerName ?? config.providerId ?? 'unnamed'}" (${where})`
    : `env-configured LLM provider (${where})`;
}

function errorResponse(
  status: number,
  code: DefaultModelsErrorCode,
  error: string,
  config?: ModelProviderConfig,
  source?: DefaultProviderSource,
): NextResponse {
  return NextResponse.json(
    {
      error,
      code,
      ...(source ? { source } : {}),
      ...(config
        ? {
            provider: config.provider,
            baseURL: redactBaseURL(config.baseURL),
            ...(config.providerId ? { providerId: config.providerId } : {}),
            ...(config.providerName ? { providerName: config.providerName } : {}),
          }
        : {}),
    },
    { status },
  );
}

export const NO_PROVIDER_MESSAGE =
  'No LLM provider is configured. Mark a provider as default in Settings → LLM Providers, ' +
  'or set LLM_PROVIDER and its base URL in the server environment.';

/** Resolve the default provider config: registry default first, env fallback, else null. */
export async function resolveDefaultProviderConfig(): Promise<{ config: ModelProviderConfig; source: DefaultProviderSource } | null> {
  const record = await getDefaultLlmProviderRecord();
  if (record) {
    return { config: resolveModelProviderConfigFromRecord(record), source: 'registry' };
  }
  const envConfig = resolveModelProviderConfigFromEnv();
  if (envProviderConfigured(envConfig)) {
    return { config: envConfig, source: 'env' };
  }
  return null;
}

export async function defaultProviderModelsResponse(): Promise<NextResponse> {
  const resolved = await resolveDefaultProviderConfig();
  if (!resolved || !resolved.config.baseURL.trim()) {
    return errorResponse(409, 'llm_provider_not_configured', NO_PROVIDER_MESSAGE, resolved?.config, resolved?.source);
  }

  const { config, source } = resolved;
  try {
    // S2: a URL with user:pass@ (registry row saved before the check, or env) is a config error.
    assertNoBaseURLCredentials(config.baseURL);
    return NextResponse.json(await listProviderModelsFromConfig(config));
  } catch (err) {
    const who = describeProvider(config, source);
    if (err instanceof ProviderConfigError) {
      return errorResponse(err.status, err.code, `The ${who} is misconfigured: ${err.message}`, config, source);
    }
    if (isUnreachableError(err)) {
      return errorResponse(503, 'llm_provider_unreachable', `Could not reach the ${who}: ${redactUrlsInText(causeDetail(err))}.`, config, source);
    }
    const detail = redactUrlsInText(err instanceof Error ? err.message : 'Failed to list models');
    return errorResponse(502, 'llm_provider_error', `The ${who} returned an error: ${detail}`, config, source);
  }
}
