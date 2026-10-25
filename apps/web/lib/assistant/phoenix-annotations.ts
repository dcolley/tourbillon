/**
 * OBS-2: posts reaction annotations to Phoenix (server side). Skipped when Phoenix is not
 * configured (PHOENIX_COLLECTOR_ENABLED off; see phoenixApiBaseUrl). A failure never fails the
 * save: the reaction is already stored locally, and saving it again re-posts the same annotation
 * (Phoenix upserts on name + trace + identifier).
 */
import { phoenixApiBaseUrl } from '@tourbillon/shared';
import type { AnnotationOutcome, TraceAnnotation } from './feedback';

export const PHOENIX_ANNOTATION_TIMEOUT_MS = 5000;

export interface PhoenixAnnotationDeps {
  /** Phoenix REST base URL; defaults to phoenixApiBaseUrl(). */
  baseUrl?: string | null;
  /** Bearer token; defaults to PHOENIX_API_KEY. */
  apiKey?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function postTraceAnnotation(
  annotation: TraceAnnotation,
  deps: PhoenixAnnotationDeps = {},
): Promise<AnnotationOutcome> {
  const baseUrl = 'baseUrl' in deps ? deps.baseUrl : phoenixApiBaseUrl();
  if (!baseUrl) return 'skipped';
  const apiKey = 'apiKey' in deps ? deps.apiKey : process.env.PHOENIX_API_KEY?.trim() || null;
  const f = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await f(`${baseUrl}/v1/trace_annotations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: [annotation] }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? PHOENIX_ANNOTATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[assistant-feedback] Phoenix refused the annotation', res.status);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    // No URL or response text in the log: the Phoenix address may be internal.
    console.warn('[assistant-feedback] Phoenix annotation failed', err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}
