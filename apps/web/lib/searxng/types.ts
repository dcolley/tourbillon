export type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
  category?: string;
  publishedDate?: string;
};

export type SearxngSearchResponse = {
  query?: string;
  number_of_results?: number;
  results?: SearxngResult[];
  answers?: string[];
  suggestions?: string[];
  unresponsive_engines?: Array<[string, string]>;
};

export type SearxngSearchResultItem = {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  score?: number;
  category?: string;
  publishedDate?: string;
};

export type SearxngToolResponse = {
  success: boolean;
  query?: string;
  numberOfResults?: number;
  results: SearxngSearchResultItem[];
  answers?: string[];
  suggestions?: string[];
  error?: string;
};

export class SearxngUpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly bodyPreview?: string,
  ) {
    super(message);
    this.name = 'SearxngUpstreamError';
  }
}
