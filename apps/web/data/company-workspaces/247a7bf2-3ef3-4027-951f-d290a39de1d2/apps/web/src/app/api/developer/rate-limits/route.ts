// ============================================================================
// TOUR-128: Rate Limits API — Real-time quota dashboard endpoint
// 
// GET    /api/developer/rate-limits - Get current rate limit usage per plan tier
// ============================================================================

import { NextResponse } from 'next/server';

interface RateLimitCategory {
  name: string;
  endpoint: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string; // ISO timestamp
}

interface PlanTier {
  id: string;
  name: string;
  rateLimits: RateLimitCategory[];
}

/**
 * GET - Get rate limit information for the current plan tier
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const planParam = url.searchParams.get('plan'); // 'free', 'pro', 'enterprise'
    
    // Define rate limits per plan tier
    const plans: Record<string, PlanTier> = {
      free: {
        id: 'free',
        name: 'Free Tier',
        rateLimits: [
          {
            name: 'API Requests',
            endpoint: '/api/*',
            limit: 10_000,
            used: Math.floor(Math.random() * 8_000) + 500, // Simulated current usage
            remaining: 0, // Will be calculated below
            resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // ~30 days
          },
          {
            name: 'Webhook Delivery',
            endpoint: '/api/webhooks',
            limit: 1_000,
            used: Math.floor(Math.random() * 800) + 50,
            remaining: 0,
            resetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // ~7 days
          },
          {
            name: 'File Uploads',
            endpoint: '/api/upload',
            limit: 500,
            used: Math.floor(Math.random() * 400) + 20,
            remaining: 0,
            resetAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // ~14 days
          },
        ],
      },
      pro: {
        id: 'pro',
        name: 'Pro Tier',
        rateLimits: [
          {
            name: 'API Requests',
            endpoint: '/api/*',
            limit: 100_000,
            used: Math.floor(Math.random() * 80_000) + 5_000,
            remaining: 0,
            resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            name: 'Webhook Delivery',
            endpoint: '/api/webhooks',
            limit: 50_000,
            used: Math.floor(Math.random() * 40_000) + 2_000,
            remaining: 0,
            resetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            name: 'File Uploads',
            endpoint: '/api/upload',
            limit: 5_000,
            used: Math.floor(Math.random() * 3_000) + 200,
            remaining: 0,
            resetAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
      enterprise: {
        id: 'enterprise',
        name: 'Enterprise Tier',
        rateLimits: [
          {
            name: 'API Requests',
            endpoint: '/api/*',
            limit: 1_000_000,
            used: Math.floor(Math.random() * 800_000) + 50_000,
            remaining: 0,
            resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            name: 'Webhook Delivery',
            endpoint: '/api/webhooks',
            limit: 500_000,
            used: Math.floor(Math.random() * 400_000) + 20_000,
            remaining: 0,
            resetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            name: 'File Uploads',
            endpoint: '/api/upload',
            limit: 50_000,
            used: Math.floor(Math.random() * 30_000) + 2_000,
            remaining: 0,
            resetAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    };

    // Default to free if no plan specified, or use provided plan
    const planKey = (planParam && plans[planParam]) ? planParam : 'free';
    const plan = plans[planKey];

    // Calculate remaining for each category
    plan.rateLimits.forEach((rl) => {
      rl.remaining = Math.max(0, rl.limit - rl.used);
    });

    console.log(`[RATE LIMITS API] Returning ${plan.name} tier limits`);

    return NextResponse.json({
      plan: {
        id: plan.id,
        name: plan.name,
        upgradeAvailable: planKey !== 'enterprise',
      },
      rateLimits: plan.rateLimits,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[RATE LIMITS API] Error fetching rate limits:', error);
    return NextResponse.json(
      { error: 'Failed to fetch rate limit information' },
      { status: 500 }
    );
  }
}
