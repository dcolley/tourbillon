/**
 * #105 B2: post-unlock redirect target. Only same-origin relative paths are allowed.
 *
 * Browsers strip TAB/LF/CR from URLs and treat `\` like `/`, so `/<TAB>/evil.com` or
 * `/\evil.com` become `//evil.com` (protocol-relative → off-site). We therefore:
 *   1. require exactly one leading `/` (no `//`);
 *   2. reject any control character, whitespace or backslash anywhere;
 *   3. resolve against an origin and require the origin to be unchanged
 *      (`new URL(next, origin).origin === origin`), returning the normalised path.
 * Anything else falls back to `/dashboard`.
 * Pure module: used by the /unlock server page and re-checked in the client form.
 */
export const SAFE_NEXT_FALLBACK = '/dashboard';

/** Placeholder origin for the server-side check (the page doesn't need the real host). */
const CHECK_ORIGIN = 'http://tourbillon.invalid';

const UNSAFE_CHARS = /[\u0000-\u001F\u007F\\\s]/;

/** Same-origin check for a relative path against a given origin; returns the normalised path or null. */
export function sameOriginPath(next: string, origin: string): string | null {
  if (next.length === 0 || next.length > 2048) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  if (UNSAFE_CHARS.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  return url.pathname + url.search + url.hash;
}

export function safeNext(next: string | string[] | undefined | null): string {
  const v = Array.isArray(next) ? next[0] : next;
  if (typeof v !== 'string') return SAFE_NEXT_FALLBACK;
  return sameOriginPath(v, CHECK_ORIGIN) ?? SAFE_NEXT_FALLBACK;
}
