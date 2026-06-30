export interface SearchFilters {
  nativeRetweets?: boolean;
  media?: boolean;
  videos?: boolean;
  news?: boolean;
  nativeVideo?: boolean;
  replies?: boolean;
  links?: boolean;
  images?: boolean;
  quote?: boolean;
  spaces?: boolean;
}

export interface SearchTweetsInput {
  query: string;
  since?: string;
  until?: string;
  minFaves?: number;
  include?: SearchFilters;
  exclude?: SearchFilters;
}

export interface SearchUsersInput {
  query: string;
  cursor?: string;
}

export interface NitterRateLimitedErrorDetails {
  statusCode: number;
  retryAfterSeconds?: number;
  snippet: string;
}

export class NitterRateLimitedError extends Error {
  public readonly details: NitterRateLimitedErrorDetails;

  constructor(details: NitterRateLimitedErrorDetails) {
    super('Nitter server is rate limited');
    this.name = 'NitterRateLimitedError';
    this.details = details;
  }
}

export class NitterUpstreamError extends Error {
  public readonly statusCode: number;
  public readonly snippet: string;

  constructor(statusCode: number, message: string, snippet: string) {
    super(message);
    this.name = 'NitterUpstreamError';
    this.statusCode = statusCode;
    this.snippet = snippet;
  }
}

export class NitterPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NitterPayloadError';
  }
}
