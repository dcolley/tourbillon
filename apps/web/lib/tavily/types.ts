export type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
};

export type TavilySearchResponse = {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
  response_time?: number;
};

export type TavilySearchResultItem = {
  title: string;
  url: string;
  content?: string;
  score?: number;
};

export type TavilyToolResponse = {
  success: boolean;
  query?: string;
  answer?: string;
  results: TavilySearchResultItem[];
  error?: string;
};

export class TavilyUpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly bodyPreview?: string,
  ) {
    super(message);
    this.name = 'TavilyUpstreamError';
  }
}
