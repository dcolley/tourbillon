import { SAFE_NEXT_FALLBACK, sameOriginPath } from './safe-next';

/** Placeholder origin: only the path is checked, so the real host isn't needed. */
const CHECK_ORIGIN = 'http://tourbillon.invalid';

/** Landing path used when `returnTo` is missing or not a usable path. */
export const RETURN_TO_FALLBACK = SAFE_NEXT_FALLBACK;

/**
 * Where the company selector goes after a company is chosen.
 * Accepts a same-origin relative path (normalised); anything else uses `fallback()`,
 * which defaults to the landing path of the stored view.
 */
export function resolveReturnTo(
  returnTo: string | null | undefined,
  fallback: () => string = () => RETURN_TO_FALLBACK,
): string {
  if (typeof returnTo === 'string') {
    const path = sameOriginPath(returnTo, CHECK_ORIGIN);
    if (path !== null) return path;
  }
  return fallback();
}
