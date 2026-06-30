import { SEARXNG_SEARCH_TIMEOUT_MS } from './config';
import type {
  SearxngResult,
  SearxngSearchResponse,
  SearxngSearchResultItem,
  SearxngToolResponse,
} from './types';
import { SearxngUpstreamError } from './types';

export interface SearxngSearchParams {
  baseUrl: string;
  apiKey?: string | null;
  query: string;
  maxResults: number;
  categories?: string;
  language?: string;
  timeRange?: string;
  safesearch?: number;
}

function normalizeResults(results: SearxngResult[], maxResults: number): SearxngSearchResultItem[] {
  return results
    .filter((row): row is SearxngResult => Boolean(row?.url && row?.title))
    .slice(0, maxResults)
    .map((row) => ({
      title: row.title!,
      url: row.url!,
      content: typeof row.content === 'string' ? row.content : undefined,
      engine: typeof row.engine === 'string' ? row.engine : undefined,
      score: typeof row.score === 'number' ? row.score : undefined,
      category: typeof row.category === 'string' ? row.category : undefined,
      publishedDate: typeof row.publishedDate === 'string' ? row.publishedDate : undefined,
    }));
}

export async function callSearxngSearch(params: SearxngSearchParams): Promise<SearxngSearchResponse> {
  const searchParams = new URLSearchParams({
    q: params.query.slice(0, 400),
    format: 'json',
  });

  if (params.categories) searchParams.set('categories', params.categories);
  if (params.language) searchParams.set('language', params.language);
  if (params.timeRange) searchParams.set('time_range', params.timeRange);
  if (params.safesearch != null) searchParams.set('safesearch', String(params.safesearch));

  const url = `${params.baseUrl.replace(/\/+$/, '')}/search?${searchParams.toString()}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SEARXNG_SEARCH_TIMEOUT_MS)
      : undefined;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new SearxngUpstreamError(
      `SearXNG error ${res.status}: ${body || res.statusText}`,
      res.status,
      body.slice(0, 200),
    );
  }

  return (await res.json()) as SearxngSearchResponse;
}

export async function runSearxngSearch(params: SearxngSearchParams): Promise<SearxngToolResponse> {
  try {
    const data = await callSearxngSearch(params);
    const rawResults = Array.isArray(data.results) ? data.results : [];
    const results = normalizeResults(rawResults, params.maxResults);

    return {
      success: true,
      query: data.query ?? params.query,
      numberOfResults: data.number_of_results,
      results,
      answers: Array.isArray(data.answers)
        ? data.answers.filter((value): value is string => typeof value === 'string')
        : undefined,
      suggestions: Array.isArray(data.suggestions)
        ? data.suggestions.filter((value): value is string => typeof value === 'string')
        : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, results: [], error: message };
  }
}
