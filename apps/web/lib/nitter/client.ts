import { getNitterUrlOrDefault } from './config';
import { parseRssFeed, type ParsedRssFeed } from './parsers/rss';
import { parseUsersSearchHtml, type ParsedUserSearchPage } from './parsers/users-html';
import { createUrlRewriter, rewriteUrlsDeep } from './rewrite-urls';
import {
  NitterPayloadError,
  NitterRateLimitedError,
  NitterUpstreamError,
  type SearchFilters,
  type SearchTweetsInput,
  type SearchUsersInput,
} from './types';

const RATE_LIMIT_PATTERN =
  /(rate.?limit|too many requests|retry later|temporarily limited|throttled)/i;

const FILTER_PARAM_MAP = {
  nativeRetweets: 'nativeretweets',
  media: 'media',
  videos: 'videos',
  news: 'news',
  nativeVideo: 'native_video',
  replies: 'replies',
  links: 'links',
  images: 'images',
  quote: 'quote',
  spaces: 'spaces',
} as const;

interface FetchResult {
  responseUrl: string;
  text: string;
}

interface RateLimitContext {
  statusCode: number;
  text: string;
  retryAfterSeconds?: number;
  snippet: string;
}

function isLikelyHtml(payload: string): boolean {
  return /^\s*<!DOCTYPE html>/i.test(payload) || /^\s*<html/i.test(payload);
}

function isLikelyRss(payload: string): boolean {
  return /^\s*<\?xml/i.test(payload) && /<rss[\s>]/i.test(payload);
}

function extractSnippet(payload: string, maxLength = 300): string {
  return payload.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function parseRetryAfterSeconds(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return undefined;

  const asInt = Number.parseInt(retryAfter, 10);
  return Number.isFinite(asInt) ? asInt : undefined;
}

function throwIfRateLimited({
  statusCode,
  text,
  retryAfterSeconds,
  snippet,
}: RateLimitContext): void {
  if (
    statusCode === 429 ||
    (statusCode >= 400 && RATE_LIMIT_PATTERN.test(text)) ||
    RATE_LIMIT_PATTERN.test(text)
  ) {
    throw new NitterRateLimitedError({ statusCode, retryAfterSeconds, snippet });
  }
}

function applyFilters(
  params: URLSearchParams,
  filters: SearchFilters | undefined,
  prefix: 'f-' | 'e-',
): void {
  if (!filters) return;

  for (const [inputKey, queryName] of Object.entries(FILTER_PARAM_MAP)) {
    const typedInputKey = inputKey as keyof SearchFilters;
    if (filters[typedInputKey]) {
      params.set(`${prefix}${queryName}`, 'on');
    }
  }
}

export class NitterClient {
  private readonly baseUrl: string;
  private readonly rewriteString: (value: string) => string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? getNitterUrlOrDefault();
    this.rewriteString = createUrlRewriter(this.baseUrl);
  }

  async searchTweets(input: SearchTweetsInput): Promise<{
    requestUrl: string;
    kind: 'tweet_search';
    query: string;
    channel: ParsedRssFeed['channel'];
    items: ParsedRssFeed['items'];
  }> {
    const params = new URLSearchParams();
    params.set('f', 'tweets');
    params.set('q', input.query);

    if (input.since) params.set('since', input.since);
    if (input.until) params.set('until', input.until);
    if (typeof input.minFaves === 'number') {
      params.set('min_faves', String(input.minFaves));
    }

    applyFilters(params, input.include, 'f-');
    applyFilters(params, input.exclude, 'e-');

    const result = await this.fetchNitter('/search/rss', params, 'rss');
    const feed = parseRssFeed(result.text);

    return rewriteUrlsDeep(
      {
        requestUrl: result.responseUrl,
        kind: 'tweet_search' as const,
        query: input.query,
        channel: feed.channel,
        items: feed.items,
      },
      this.rewriteString,
    );
  }

  async feedUser(username: string): Promise<{
    requestUrl: string;
    kind: 'user_feed';
    username: string;
    channel: ParsedRssFeed['channel'];
    items: ParsedRssFeed['items'];
  }> {
    const path = `/${encodeURIComponent(username)}/rss`;
    const result = await this.fetchNitter(path, new URLSearchParams(), 'rss');
    const feed = parseRssFeed(result.text);

    return rewriteUrlsDeep(
      {
        requestUrl: result.responseUrl,
        kind: 'user_feed' as const,
        username,
        channel: feed.channel,
        items: feed.items,
      },
      this.rewriteString,
    );
  }

  async searchUsers(input: SearchUsersInput): Promise<{
    requestUrl: string;
    kind: 'user_search';
    query: string;
    users: ParsedUserSearchPage['users'];
    nextCursor: string | null;
  }> {
    const params = new URLSearchParams();
    params.set('f', 'users');
    params.set('q', input.query);

    if (input.cursor) params.set('cursor', input.cursor);

    const result = await this.fetchNitter('/search', params, 'html');
    const page = parseUsersSearchHtml(result.text, this.baseUrl);

    return rewriteUrlsDeep(
      {
        requestUrl: result.responseUrl,
        kind: 'user_search' as const,
        query: input.query,
        users: page.users,
        nextCursor: page.nextCursor,
      },
      this.rewriteString,
    );
  }

  private async fetchNitter(
    path: string,
    params: URLSearchParams,
    expectedPayload: 'rss' | 'html',
  ): Promise<FetchResult> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        accept:
          expectedPayload === 'rss'
            ? 'application/rss+xml,application/xml,text/xml'
            : 'text/html,application/xhtml+xml',
      },
    });

    const text = await response.text();
    const snippet = extractSnippet(text);
    const retryAfterSeconds = parseRetryAfterSeconds(response);

    throwIfRateLimited({ statusCode: response.status, text, retryAfterSeconds, snippet });

    if (!response.ok) {
      throw new NitterUpstreamError(
        response.status,
        `Nitter request failed with status ${response.status}`,
        snippet,
      );
    }

    if (expectedPayload === 'rss' && !isLikelyRss(text)) {
      throw new NitterPayloadError(
        `Expected RSS response but received a different payload (${snippet})`,
      );
    }

    if (expectedPayload === 'html' && !isLikelyHtml(text)) {
      throw new NitterPayloadError(
        `Expected HTML response but received a different payload (${snippet})`,
      );
    }

    return { responseUrl: response.url, text };
  }
}

export {
  NitterPayloadError,
  NitterRateLimitedError,
  NitterUpstreamError,
} from './types';
