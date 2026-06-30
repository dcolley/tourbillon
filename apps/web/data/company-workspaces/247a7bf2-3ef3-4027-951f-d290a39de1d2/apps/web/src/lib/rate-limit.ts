/**
 * In-memory rate limiter for Next.js API routes.
 * Uses a sliding window algorithm to track request counts per IP address.
 * This is suitable for single-instance deployments; for multi-instance, use Redis-backed ratelimit (e.g. @upstash/ratelimit).
 */

interface RateLimitEntry {
  count: number;
  resetAt: number; // timestamp when this window resets
}

// In-memory store keyed by IP address
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Check if a request from the given IP is within rate limits.
 * @param ip - Client IP address (from X-Forwarded-For or remoteAddress)
 * @param windowMs - Rate limit window in milliseconds
 * @param maxRequests - Maximum requests allowed per window
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(
  ip: string,
  windowMs: number = 60_000, // default 1 minute
  maxRequests: number = 100   // default 100 requests per window
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();

  let entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    // New window — reset counter
    entry = { count: 0, resetAt: now + windowMs };
  }

  entry.count++;

  const allowed = entry.count <= maxRequests;
  const remaining = Math.max(0, maxRequests - entry.count);

  rateLimitStore.set(ip, entry);

  return { allowed, remaining, resetAt: entry.resetAt };
}

/**
 * Get rate limit headers to attach to responses.
 */
export function getRateLimitHeaders(limit: number, remaining: number, resetAt: number): Record<string, string> {
  const retryAfter = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));

  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.floor(resetAt / 1000)),
    ...(remaining === 0 && { 'Retry-After': String(retryAfter) }),
  };
}

/**
 * Cleanup stale entries periodically (every 5 minutes).
 * Prevents memory leaks from IPs that never return.
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 5 * 60 * 1000);
