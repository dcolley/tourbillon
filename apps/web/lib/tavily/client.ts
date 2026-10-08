import {
  fetchWithToolEgress,
  isToolEgressBlockedError,
  type ToolEgressPolicy,
} from '@tourbillon/shared/tool-egress';
import { TAVILY_SEARCH_TIMEOUT_MS } from './config';
import type {
  TavilyResult,
  TavilySearchResponse,
  TavilySearchResultItem,
  TavilyToolResponse,
} from './types';
import { TavilyUpstreamError } from './types';

export interface TavilySearchParams {
  apiKey: string;
  query: string;
  maxResults: number;
  searchDepth?: 'basic' | 'advanced';
  includeAnswer?: boolean;
  /** Company/agent tool egress allow-list; unset = every host. */
  egressPolicy?: ToolEgressPolicy;
}

function normalizeResults(results: TavilyResult[], maxResults: number): TavilySearchResultItem[] {
  return results
    .filter((row): row is TavilyResult => Boolean(row?.url && row?.title))
    .slice(0, maxResults)
    .map((row) => ({
      title: row.title!,
      url: row.url!,
      content: typeof row.content === 'string' ? row.content : undefined,
      score: typeof row.score === 'number' ? row.score : undefined,
    }));
}

export async function callTavilySearch(params: TavilySearchParams): Promise<TavilySearchResponse> {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(TAVILY_SEARCH_TIMEOUT_MS)
      : undefined;

  const res = await fetchWithToolEgress(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        api_key: params.apiKey,
        query: params.query.slice(0, 400),
        max_results: params.maxResults,
        search_depth: params.searchDepth ?? 'basic',
        include_answer: params.includeAnswer ?? true,
      }),
      ...(signal ? { signal } : {}),
    },
    params.egressPolicy,
  );

  if (!res.ok) {
    const body = await res.text();
    throw new TavilyUpstreamError(
      `Tavily error ${res.status}: ${body || res.statusText}`,
      res.status,
      body.slice(0, 200),
    );
  }

  return (await res.json()) as TavilySearchResponse;
}

export async function runTavilySearch(params: TavilySearchParams): Promise<TavilyToolResponse> {
  try {
    const data = await callTavilySearch(params);
    const rawResults = Array.isArray(data.results) ? data.results : [];
    const results = normalizeResults(rawResults, params.maxResults);

    return {
      success: true,
      query: data.query ?? params.query,
      answer: typeof data.answer === 'string' ? data.answer : undefined,
      results,
    };
  } catch (err) {
    // Allow-list refusals are handled by the route (403 + activity row), not as a search failure.
    if (isToolEgressBlockedError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, results: [], error: message };
  }
}
