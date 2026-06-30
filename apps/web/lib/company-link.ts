const DEEP_LINK_PATTERNS = [
  /^\/issue\/[^/]+$/,
  /^\/goal\/[^/]+$/,
  /^\/project\/[^/]+$/,
  /^\/heartbeat\/[^/]+$/,
  /^\/agent\/[^/]+$/,
];

export function isDeepLinkPath(pathname: string): boolean {
  return DEEP_LINK_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function companyScopedHref(path: string, companyId: string): string {
  const [base, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('c', companyId);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : `${base}?c=${companyId}`;
}

export function parseCompanyIdFromSearchParams(
  searchParams: Record<string, string | string[] | undefined> | URLSearchParams
): string | null {
  const raw =
    searchParams instanceof URLSearchParams
      ? searchParams.get('c')
      : typeof searchParams.c === 'string'
        ? searchParams.c
        : Array.isArray(searchParams.c)
          ? searchParams.c[0]
          : null;
  return raw?.trim() || null;
}
