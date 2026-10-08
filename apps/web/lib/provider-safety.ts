/**
 * Hardening for outbound calls to LLM providers (model listing) and for echoing provider URLs.
 * #121 Test softs:
 * - S1: scrub the stored API key, header values and Bearer/Basic strings from upstream error text.
 * - S2: base URLs with user:pass@ are refused (409); userinfo, query and fragment are stripped
 *   wherever a base URL is echoed back.
 * - S3: no automatic redirects. Same-host redirects are followed by hand (bounded); a redirect
 *   to another host, or from https to http, is refused with a clear error.
 * - S4: bounded body reads (error snippets and the models JSON), never a full res.text().
 */

/** Error-body bytes read before giving up; only the first ERROR_SNIPPET_CHARS are shown. */
export const PROVIDER_ERROR_BODY_MAX_BYTES = 64 * 1024;
/** Successful model-list JSON larger than this is refused rather than buffered. */
export const PROVIDER_MODELS_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const PROVIDER_ERROR_SNIPPET_CHARS = 200;
export const PROVIDER_MAX_REDIRECTS = 3;
export const REDACTED = '[redacted]';

export type ProviderConfigErrorCode = 'llm_provider_base_url_credentials';

/** A provider config that can never work (not an upstream failure): maps to 409. */
export class ProviderConfigError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly code: ProviderConfigErrorCode,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export const BASE_URL_CREDENTIALS_MESSAGE =
  'The base URL contains a username or password (user:pass@host). Credentials in the URL are not ' +
  'supported: remove them and put the key in the API key field or a custom header.';

function tryParse(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** True when the URL carries userinfo (user:pass@ or user@). */
export function baseURLHasCredentials(raw: string): boolean {
  const u = tryParse(raw);
  if (u) return Boolean(u.username || u.password);
  // Unparseable: be conservative about anything that looks like userinfo before the host.
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(raw.trim());
}

export function assertNoBaseURLCredentials(raw: string): void {
  if (baseURLHasCredentials(raw)) {
    throw new ProviderConfigError(BASE_URL_CREDENTIALS_MESSAGE, 'llm_provider_base_url_credentials');
  }
}

/**
 * Base URL safe to echo back: userinfo, query string and fragment removed. A URL without any of
 * those is returned unchanged (so stored URLs round-trip byte-for-byte).
 */
export function redactBaseURL(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return raw;
  const trimmed = raw.trim();
  const u = tryParse(trimmed);
  if (!u) {
    return trimmed.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, '$1').replace(/[?#].*$/s, '');
  }
  if (!u.username && !u.password && !/[?#]/.test(trimmed)) return raw;
  // Keep "http://host" without a trailing slash when the original had no path.
  const hadPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(trimmed);
  const path = u.pathname === '/' && !hadPath ? '' : u.pathname;
  return `${u.protocol}//${u.host}${path}`;
}

/** Replace userinfo, query and fragment of any http(s) URL inside free text. */
export function redactUrlsInText(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>`)]+/gi, (url) => redactBaseURL(url));
}

/**
 * `${baseURL}/<path>` built on the URL path, so a query string in the base URL stays a query
 * string (`http://h/v1?k=v` → `http://h/v1/models?k=v`, not `http://h/v1?k=v/models`).
 */
export function providerEndpoint(baseURL: string, path: string): string {
  const u = tryParse(baseURL);
  const suffix = path.replace(/^\/+/, '');
  if (!u) return `${baseURL.trim().replace(/\/$/, '')}/${suffix}`;
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${suffix}`;
  return u.toString();
}

/**
 * Same trust boundary for credentials: same host (hostname and port) and not an https → http
 * downgrade. http → https on the same hostname with default ports is allowed.
 */
export function sameCredentialBoundary(from: string | URL, to: string | URL): boolean {
  const a = typeof from === 'string' ? tryParse(from) : from;
  const b = typeof to === 'string' ? tryParse(to) : to;
  if (!a || !b) return false;
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  if (a.protocol === b.protocol) return a.port === b.port;
  // Upgrade only, and only between default ports (http://h → https://h).
  return a.protocol === 'http:' && b.protocol === 'https:' && a.port === '' && b.port === '';
}

/** `origin` of a URL for messages (never userinfo/query). */
function originOf(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Secrets shorter than this are not scrubbed (they'd mangle the text and protect nothing). */
const MIN_SECRET_LENGTH = 3;

/**
 * S1: remove secrets from upstream text before it reaches a response or a log: every given
 * secret (raw, JSON-escaped and URL-encoded forms), any `Bearer …`/`Basic …` credential, and
 * userinfo/query strings of URLs.
 */
export function scrubProviderSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  const variants = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== 'string') continue;
    for (const candidate of [s, s.trim()]) {
      if (candidate.length < MIN_SECRET_LENGTH) continue;
      variants.add(candidate);
      variants.add(JSON.stringify(candidate).slice(1, -1));
      try {
        variants.add(encodeURIComponent(candidate));
      } catch {
        // lone surrogate: skip the encoded form
      }
    }
  }
  let out = text;
  // Longest first so a secret that contains another is replaced whole.
  for (const v of [...variants].sort((x, y) => y.length - x.length)) {
    if (v.length < MIN_SECRET_LENGTH) continue;
    out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTED);
  }
  out = out.replace(/\b(Bearer|Basic)\s+(?!\[redacted\])\S+/gi, `$1 ${REDACTED}`);
  return redactUrlsInText(out);
}

/** Every value that must never be echoed for a provider config: key, header values, URL parts. */
export function providerSecretValues(config: {
  apiKey?: string | null;
  headers?: Record<string, string>;
  baseURL?: string;
}, sentHeaders?: Record<string, string>): string[] {
  const out: string[] = [];
  if (config.apiKey) out.push(config.apiKey);
  for (const v of Object.values(config.headers ?? {})) out.push(v);
  for (const v of Object.values(sentHeaders ?? {})) out.push(v);
  const u = config.baseURL ? tryParse(config.baseURL) : null;
  if (u) {
    if (u.password) out.push(decodeURIComponent(u.password), u.password);
    if (u.username) out.push(decodeURIComponent(u.username), u.username);
    for (const v of u.searchParams.values()) out.push(v);
  }
  return out;
}

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeded ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * S4: read at most `maxBytes` of a response body. Stops reading (and cancels the stream) once
 * the cap is reached; never buffers more than maxBytes (+ one chunk). `truncated` says whether
 * the body was cut.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - received;
      if (value.byteLength > room) {
        if (room > 0) text += decoder.decode(value.subarray(0, room), { stream: true });
        received = maxBytes;
        truncated = true;
        break;
      }
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => {});
    } else {
      reader.releaseLock();
    }
  }
  return { text, truncated };
}

/** JSON body, refusing anything over `maxBytes` instead of buffering it. */
export async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  const { text, truncated } = await readBodyCapped(res, maxBytes);
  if (truncated) throw new ResponseTooLargeError(maxBytes);
  return JSON.parse(text) as T;
}

export class ProviderRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRedirectError';
  }
}

/**
 * S3: GET with `redirect: 'manual'`. A 3xx to the same host (or an http → https upgrade) is
 * followed by hand, at most PROVIDER_MAX_REDIRECTS times; a 3xx to any other host, or an
 * https → http downgrade, is refused so stored headers never reach another origin.
 */
export async function fetchWithoutCrossHostRedirects(
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current.toString(), {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      redirect: 'manual',
    });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;

    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (!location) {
      throw new ProviderRedirectError(`provider answered ${res.status} without a Location header`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ProviderRedirectError(`provider answered ${res.status} with an invalid Location header`);
    }
    if (!sameCredentialBoundary(current, next)) {
      throw new ProviderRedirectError(
        `provider redirected (${res.status}) from ${originOf(current)} to a different host ` +
          `(${originOf(next)}); refusing to follow it with the provider's credentials. ` +
          'Point the base URL at the final address instead.',
      );
    }
    if (hop + 1 > PROVIDER_MAX_REDIRECTS) {
      throw new ProviderRedirectError(`provider redirected more than ${PROVIDER_MAX_REDIRECTS} times`);
    }
    current = next;
  }
}
