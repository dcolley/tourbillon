/**
 * Extract the public origin from a NextRequest, suitable for minting absolute URLs.
 * Rejects listen addresses (0.0.0.0, ::, [::]) and prefers client-facing headers.
 *
 * @param req - The NextRequest object
 * @returns The public origin string (e.g. "http://192.168.10.170:3002")
 * @throws Error if only a listen address is available
 */
export function publicOriginFromRequest(req: { headers: Headers; url?: string }): string {
  const origin = req.headers.get('origin');
  const xForwardedHost = req.headers.get('x-forwarded-host');
  const xForwardedProto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('host');

  // Helper to check if a host is a listen address
  const isListenAddress = (h: string | null): boolean => {
    if (!h) return false;
    const normalized = h.toLowerCase();
    return (
      normalized === '0.0.0.0' ||
      normalized.startsWith('0.0.0.0:') ||
      normalized === '::' ||
      normalized === '[::]' ||
      normalized.startsWith('[::]:')
    );
  };

  // Extract protocol from origin for later use
  let inferredProto = 'http';
  if (origin) {
    try {
      const originUrl = new URL(origin);
      inferredProto = originUrl.protocol.replace(':', '');
    } catch {
      // Invalid origin, ignore
    }
  }

  // Prefer x-forwarded-host (set by reverse proxies)
  if (xForwardedHost && !isListenAddress(xForwardedHost)) {
    const proto = xForwardedProto || inferredProto;
    return `${proto}://${xForwardedHost}`;
  }

  // Fall back to Host header
  if (host && !isListenAddress(host)) {
    return `${inferredProto}://${host}`;
  }

  // Use origin only if host headers are unavailable or listen addresses
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!isListenAddress(originUrl.host)) {
        return origin;
      }
    } catch {
      // Invalid origin, continue
    }
  }

  // If req.url is available, try to parse it
  if (req.url) {
    try {
      const parsed = new URL(req.url);
      if (!isListenAddress(parsed.host)) {
        return parsed.origin;
      }
    } catch {
      // Invalid URL, continue
    }
  }

  throw new Error(
    'Cannot derive public origin: all available headers contain listen addresses (0.0.0.0, ::, [::])',
  );
}
