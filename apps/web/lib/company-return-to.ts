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

export const SELECT_COMPANY_PATH = '/select-company';

/**
 * Where CompanyGate sends a user who has no company yet: the selector, with the current
 * page as `returnTo` when it is a safe same-origin path, so a deep link such as `/dashboard`
 * lands back on that page once a company is chosen. `/` and the selector itself are left
 * out (the selector then falls back to the stored view).
 */
export function selectCompanyHref(pathname: string | null | undefined, search = ''): string {
  if (typeof pathname !== 'string' || pathname.length === 0) return SELECT_COMPANY_PATH;
  const query = search && !search.startsWith('?') ? `?${search}` : search;
  const path = sameOriginPath(pathname + query, CHECK_ORIGIN);
  if (path === null || /^\/(?:[?#]|$)/.test(path) || /^\/select-company(?:[/?#]|$)/.test(path)) {
    return SELECT_COMPANY_PATH;
  }
  return `${SELECT_COMPANY_PATH}?returnTo=${encodeURIComponent(path)}`;
}
