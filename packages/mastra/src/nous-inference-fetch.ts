const NOUS_INFERENCE_HOST = 'inference-api.nousresearch.com';

export function isNousInferenceBaseUrl(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === NOUS_INFERENCE_HOST;
  } catch {
    return baseURL.includes(NOUS_INFERENCE_HOST);
  }
}

/** Tags required by Nous Portal / OpenRouter-backed inference API (esp. `:free` models). */
export function nousInferenceTags(): string[] {
  const user = process.env.NOUS_INFERENCE_USER_TAG?.trim() || 'tourbillon';
  const version = process.env.TOURBILLON_VERSION?.trim() || '0.1.0';
  return ['product=tourbillon', `client=tourbillon-agent-v${version}`, `user=${user}`];
}

function isChatCompletionsPost(url: string | URL, init?: RequestInit): boolean {
  const urlText = typeof url === 'string' ? url : url.toString();
  if (!urlText.includes('/chat/completions')) return false;
  const method = init?.method?.toUpperCase() ?? 'GET';
  return method === 'POST';
}

/** Inject Nous Portal attribution tags into chat completion request bodies. */
export function createNousInferenceFetch(
  baseFetch: typeof fetch,
  baseURL: string,
): typeof fetch {
  if (!isNousInferenceBaseUrl(baseURL)) return baseFetch;

  return async (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const requestInit = input instanceof Request ? undefined : init;

    if (!isChatCompletionsPost(url, requestInit)) {
      return baseFetch(input, init);
    }

    const body =
      requestInit?.body ??
      (input instanceof Request && input.method === 'POST' ? await input.clone().text() : undefined);

    if (typeof body !== 'string') {
      return baseFetch(input, init);
    }

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const existing = parsed.tags;
      if (Array.isArray(existing) && existing.length > 0) {
        return baseFetch(input, init);
      }

      const nextBody = JSON.stringify({ ...parsed, tags: nousInferenceTags() });

      if (input instanceof Request) {
        return baseFetch(new Request(input, { body: nextBody }), undefined);
      }

      return baseFetch(input, { ...requestInit, body: nextBody });
    } catch {
      return baseFetch(input, init);
    }
  };
}
