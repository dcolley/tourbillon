/**
 * Next.js Middleware for rate limiting auth endpoints.
 * 
 * This middleware runs before the request hits route handlers,
 * providing an early defense layer against brute-force and DDoS attacks.
 * It applies stricter limits to login/signup than to session checks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getRateLimitHeaders } from './lib/rate-limit';

// Rate limit tiers by endpoint type
const RATE_LIMITS = {
  auth: {
    windowMs: 60_000,     // 1 minute
    maxRequests: 20,       // 20 requests per IP per minute (strict for login/signup)
  },
  session: {
    windowMs: 60_000,     // 1 minute  
    maxRequests: 60,       // 60 requests per IP per minute (session checks can be more frequent)
  },
  default: {
    windowMs: 60_000,     // 1 minute
    maxRequests: 100,      // 100 requests per IP per minute (general API routes)
  },
};

/**
 * Determine which rate limit tier applies to a given path.
 */
function getRateLimitTier(path: string): { windowMs: number; maxRequests: number } {
  if (path.startsWith('/api/auth/login') || path.startsWith('/api/auth/signup')) {
    return RATE_LIMITS.auth;
  }
  if (path.startsWith('/api/auth/session')) {
    return RATE_LIMITS.session;
  }
  // Allow other API routes through with default limits (or no limit for static/public)
  if (!path.startsWith('/api/')) {
    return null as any; // Skip rate limiting for non-API routes
  }
  return RATE_LIMITS.default;
}

/**
 * Extract the client IP from the request, considering proxies.
 */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can be "client, proxy1, proxy2" — take the first (original client)
    return forwarded.split(',')[0].trim();
  }
  return request.ip || '127.0.0.1';
}

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  
  // Only rate limit API routes under /api/auth/ and /api/demo-request/
  if (!path.startsWith('/api/') && !path.includes('auth')) {
    return NextResponse.next();
  }

  const tier = getRateLimitTier(path);
  
  // Skip rate limiting for non-matching tiers (e.g., static assets, docs)
  if (!tier) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const { allowed, remaining, resetAt } = checkRateLimit(
    ip,
    tier.windowMs,
    tier.maxRequests
  );

  // Attach rate limit headers to every response for visibility
  const headers = getRateLimitHeaders(tier.maxRequests, remaining, resetAt);

  if (!allowed) {
    console.warn(`[Rate Limit] Blocked request from IP ${ip} on path ${path}`);
    
    return new NextResponse(
      JSON.stringify({ 
        error: 'Too many requests', 
        retryAfterSeconds: Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)) 
      }),
      {
        status: 429, // Too Many Requests
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  // Add rate limit info to response for monitoring/debugging
  const response = NextResponse.next();
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

// Configure middleware to run only on API/auth paths
export const config = {
  matcher: [
    '/api/auth/login/:path*',
    '/api/auth/signup/:path*',
    '/api/auth/session/:path*',
    '/api/auth/callback/:path*',
    '/api/demo-request/:path*',
  ],
};
