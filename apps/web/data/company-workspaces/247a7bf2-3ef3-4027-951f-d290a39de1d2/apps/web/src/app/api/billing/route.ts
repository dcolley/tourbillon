/**
 * Billing Management API Routes (TOUR-152)
 * 
 * Endpoints:
 * - GET /api/billing/subscription - Get current subscription status
 * - POST /api/billing/create-checkout-session - Create Stripe checkout session for new subscription
 * - POST /api/billing/update-subscription - Upgrade/downgrade plan
 * - GET /api/billing/invoices - List invoices for user
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getStripeClient, createCheckoutSession, getCustomerSubscriptions } from '@/lib/stripe';
import { db } from '@tourbillon/db';
import { subscriptions, invoices, subscriptionPlans } from '@tourbillon/db';
import { eq, desc, and } from 'drizzle-orm';

// ============================================================================
// GET CURRENT SUBSCRIPTION STATUS
// ============================================================================

/**
 * GET /api/billing/subscription
 * Returns the user's current subscription status.
 */
export async function GET(request: NextRequest) {
  try {
    // In production, get userId from session/auth middleware
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID required' },
        { status: 401 }
      );
    }

    // Get current subscriptions for this user from Stripe
    const stripe = getStripeClient();
    
    // Find user's Stripe customer ID (stored in metadata or separate mapping)
    // For now, we'll query our local subscriptions table first
    const userSubscriptions = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt));

    if (userSubscriptions.length === 0) {
      // User has no subscription - they're on Free tier
      return NextResponse.json({
        plan: 'free',
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      });
    }

    const latestSubscription = userSubscriptions[0];
    
    // Fetch details from Stripe to get real-time status
    let stripeSubDetails = null;
    try {
      stripeSubDetails = await stripe.subscriptions.retrieve(latestSubscription.subscriptionId);
    } catch (error) {
      console.error('Failed to retrieve subscription from Stripe:', error);
    }

    return NextResponse.json({
      plan: latestSubscription.status,
      status: stripeSubDetails?.status || latestSubscription.status,
      currentPeriodStart: latestSubscription.currentPeriodStart,
      currentPeriodEnd: latestSubscription.currentPeriodEnd,
      cancelAtPeriodEnd: latestSubscription.cancelAtPeriodEnd,
      trialEnd: latestSubscription.trialEnd,
      hasTrialEnded: latestSubscription.hasTrialEnded,
      seats: latestSubscription.seats,
      stripeSubDetails,
    });

  } catch (error) {
    console.error('Error fetching subscription status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch subscription status' },
      { status: 500 }
    );
  }
}

// ============================================================================
// CREATE CHECKOUT SESSION FOR NEW SUBSCRIPTION
// ============================================================================

/**
 * POST /api/billing/create-checkout-session
 * Creates a Stripe Checkout session for subscribing to a plan.
 * 
 * Body: { priceId, customerId, successUrl, cancelUrl, trialDays? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { priceId, customerId, successUrl, cancelUrl, trialDays } = body;

    if (!priceId || !customerId) {
      return NextResponse.json(
        { error: 'Price ID and Customer ID are required' },
        { status: 400 }
      );
    }

    const stripe = getStripeClient();
    
    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.NEXT_PUBLIC_APP_URL}/billing?success=true`,
      cancel_url: cancelUrl || `${process.env.NEXT_PUBLIC_APP_URL}/pricing?canceled=true`,
      allow_promotion_codes: true,
      ...(trialDays ? { subscription_data: { trial_period_days: trialDays } } : {}),
    });

    return NextResponse.json({ sessionId: session.id, url: session.url });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}

// ============================================================================
// UPDATE SUBSCRIPTION (UPGRADE/DOWNGRADE)
// ============================================================================

/**
 * POST /api/billing/update-subscription
 * Upgrades or downgrades a user's subscription.
 * 
 * Body: { subscriptionId, newPriceId }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { subscriptionId, newPriceId } = body;

    if (!subscriptionId || !newPriceId) {
      return NextResponse.json(
        { error: 'Subscription ID and new Price ID are required' },
        { status: 400 }
      );
    }

    const stripe = getStripeClient();
    
    // Update subscription with new price
    const updatedSub = await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: subscriptionId, price: newPriceId }],
      prorate: true,
    });

    return NextResponse.json({ subscription: updatedSub });

  } catch (error) {
    console.error('Error updating subscription:', error);
    return NextResponse.json(
      { error: 'Failed to update subscription' },
      { status: 500 }
    );
  }
}

// ============================================================================
// LIST INVOICES FOR USER
// ============================================================================

/**
 * GET /api/billing/invoices?userId=xxx&limit=10&offset=0
 */
export async function invoicesGET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('userId');
    const limit = parseInt(searchParams.get('limit') || '10', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID required' },
        { status: 401 }
      );
    }

    // Get invoices from local database (synced via webhook)
    const userInvoices = await db.select()
      .from(invoices)
      .where(eq(invoices.userId, userId))
      .orderBy(desc(invoices.issuedAt || undefined as any))
      .limit(limit)
      .offset(offset);

    // Also fetch from Stripe for completeness
    const stripe = getStripeClient();
    
    return NextResponse.json({
      invoices: userInvoices,
      count: userInvoices.length,
    });

  } catch (error) {
    console.error('Error fetching invoices:', error);
    return NextResponse.json(
      { error: 'Failed to fetch invoices' },
      { status: 500 }
    );
  }
}

// ============================================================================
// CANCEL SUBSCRIPTION
// ============================================================================

/**
 * POST /api/billing/cancel-subscription
 * Cancels the user's subscription.
 * 
 * Body: { subscriptionId, immediate? }
 */
export async function cancelSubscriptionPOST(request: NextRequest) {
  try {
    const body = await request.json();
    const { subscriptionId, immediate = false } = body;

    if (!subscriptionId) {
      return NextResponse.json(
        { error: 'Subscription ID required' },
        { status: 400 }
      );
    }

    const stripe = getStripeClient();
    
    // Cancel subscription via Stripe
    const cancelledSub = await stripe.subscriptions.cancel(subscriptionId, {
      invoice_now: immediate,
      prorate: !immediate,
    });

    // Update local database
    await db.update(subscriptions)
      .set({
        status: 'canceled',
        canceledAt: new Date(),
        cancelAtPeriodEnd: true,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.subscriptionId, subscriptionId));

    return NextResponse.json({ subscription: cancelledSub });

  } catch (error) {
    console.error('Error canceling subscription:', error);
    return NextResponse.json(
      { error: 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
}

// ============================================================================
// EXPORT ALL HANDLERS FOR DIFFERENT HTTP METHODS ON /api/billing
// ============================================================================

/**
 * Main billing route handler - routes to appropriate endpoint based on query params
 */
export async function billingHandler(request: NextRequest) {
  const url = new URL(request.url);
  
  if (url.pathname === '/api/billing/subscription') {
    return GET(request);
  } else if (request.method === 'POST' && !bodyHasPriceId(await request.text())) {
    // POST without priceId is likely cancel or update
    const body = await request.json();
    if (body.subscriptionId) {
      if (body.newPriceId) {
        return PUT(request);
      } else {
        return cancelSubscriptionPOST(request);
      }
    }
  } else if (request.method === 'POST') {
    // POST with priceId is checkout session creation
    const body = await request.json();
    if (body.priceId) {
      return POST(request);
    }
  }

  return NextResponse.json(
    { error: 'Invalid endpoint or method' },
    { status: 404 }
  );
}

function bodyHasPriceId(textBody: string): boolean {
  try {
    const parsed = JSON.parse(textBody);
    return !!parsed.priceId;
  } catch {
    return false;
  }
}
