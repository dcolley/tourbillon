import { sameOriginPath } from './safe-next';
import { homeRedirectPath } from './view-preference';

/** Placeholder origin: only the path is checked, so the real host isn't needed. */
const CHECK_ORIGIN = 'http://tourbillon.invalid';

/**
 * Where the company selector goes after a company is chosen: `returnTo` when it is a
 * same-origin relative path (normalised by the shared safe-next helper), otherwise the
 * landing page of the user's stored view (assistant by default).
 */
export function resolveReturnTo(
  returnTo: string | null | undefined,
  fallback: () => string = homeRedirectPath,
): string {
  if (typeof returnTo === 'string') {
    const path = sameOriginPath(returnTo, CHECK_ORIGIN);
    if (path !== null) return path;
  }
  return fallback();
}
