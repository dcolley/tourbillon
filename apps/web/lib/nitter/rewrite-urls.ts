const X_BASE_URL = 'https://x.com';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function createUrlRewriter(
  nitterBaseUrl: string,
  targetBaseUrl: string = X_BASE_URL,
): (value: string) => string {
  const normalizedTarget = normalizeBaseUrl(targetBaseUrl);
  const sourceBases = [
    normalizeBaseUrl(nitterBaseUrl),
    'https://localhost',
    'http://localhost',
  ].filter(Boolean);

  const patterns = sourceBases.map((sourceBase) => ({
    regex: new RegExp(escapeRegExp(sourceBase), 'g'),
    replacement: normalizedTarget,
  }));

  return (value: string): string => {
    let rewritten = value;
    for (const { regex, replacement } of patterns) {
      rewritten = rewritten.replace(regex, replacement);
    }
    return rewritten;
  };
}

export function rewriteUrlsDeep<T>(
  value: T,
  rewriteString: (input: string) => string,
): T {
  if (typeof value === 'string') {
    return rewriteString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteUrlsDeep(item, rewriteString)) as T;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => [key, rewriteUrlsDeep(nested, rewriteString)],
    );
    return Object.fromEntries(entries) as T;
  }

  return value;
}
