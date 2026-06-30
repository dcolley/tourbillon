/**
 * Stripe Billing Configuration & Utility Module (TOUR-150)
 * 
 * Provides centralized Stripe client initialization, secret key management,
 * webhook signature validation, and helper functions for subscription lifecycle.
 */

import Stripe from 'stripe';

// ============================================================================
// STRIPE INITIALIZATION
// ============================================================================

/**
 * Load environment variables with validation for required Stripe keys.
 * @throws Error if required Stripe environment variables are not set.
 */
function loadStripeConfig(): {
  secretKey: string;
  webhookSecret: string;
  publishableKey?: string;
} {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set in environment variables.');
  }
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set. Required for webhook signature validation.');
  }

  return { secretKey, webhookSecret, publishableKey: publishableKey || undefined };
}

/** Cached Stripe instance to avoid re-initialization per request */
let stripeInstance: Stripe | null = null;

/**
 * Get or create the Stripe client singleton.
 * Uses a module-level cache so multiple calls within the same execution context share one instance.
 */
export function getStripeClient(): Stripe {
  if (!stripeInstance) {
    const config = loadStripeConfig();
    stripeInstance = new Stripe(config.secretKey, {
      apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
      typescript: true,
    });
  }
  return stripeInstance;
}

// ============================================================================
// WEBHOOK SIGNATURE VALIDATION
// ============================================================================

/**
 * Validate a Stripe webhook event signature.
 * 
 * @param rawBody - The raw request body string (before any JSON parsing)
 * @param signatureHeader - The `stripe-signature` header value from the incoming request
 * @returns true if the signature is valid, false otherwise
 * 
 * Usage in route handlers:
 *   const isValid = validateWebhookSignature(req.body, req.headers['stripe-signature'] || '');
 *   if (!isValid) { throw new Error('Invalid webhook signature'); }
 */
export function validateWebhookSignature(
  rawBody: string,
  signatureHeader: string
): boolean {
  try {
    const config = loadStripeConfig();
    const stripe = getStripeClient();

    // Stripe's constructor method expects the raw body and signature header.
    // We call it here to validate without consuming the body stream.
    // Note: In practice, route handlers should pass the raw buffer/string from Next.js.
    stripe.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
    return true;
  } catch {
    // Signature mismatch or malformed payload — reject silently for security.
    return false;
  }
}

// ============================================================================
// WEBHOOK EVENT PARSING
// ============================================================================

/**
 * Parse and validate a Stripe webhook event from raw request data.
 * 
 * @param rawBody - The raw request body string
 * @param signatureHeader - The `stripe-signature` header value
 * @returns The parsed Stripe.Event if valid, null otherwise
 */
export function parseWebhookEvent(
  rawBody: string,
  signatureHeader: string
): Stripe.Event | null {
  const isValid = validateWebhookSignature(rawBody, signatureHeader);
  
  if (!isValid) {
    console.warn('Stripe webhook signature validation failed');
    return null;
  }

  try {
    // Reconstruct the event since constructEvent already validated it.
    // In production route handlers, this would use the body from the Next.js request.
    const stripe = getStripeClient();
    const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, loadStripeConfig().webhookSecret);
    return event;
  } catch (error) {
    console.error('Failed to parse Stripe webhook event:', error);
    return null;
  }
}

// ============================================================================
// SUBSCRIPTION HELPER FUNCTIONS
// ============================================================================

/**
 * Subscription status convenience check — is the subscription currently active?
 */
export function isSubscriptionActive(status: string): boolean {
  const activeStatuses = ['active', 'trialing'];
  return activeStatuses.includes(status);
}

/**
 * Get a human-readable display name for Stripe subscription statuses.
 */
export function formatSubscriptionStatus(status: string): string {
  const statusLabels: Record<string, string> = {
    incomplete: 'Incomplete',
    incomplete_expired: 'Expired (Incomplete)',
    trialing: 'Trial Period',
    active: 'Active',
    past_due: 'Past Due',
    canceled: 'Canceled',
    unpaid: 'Unpaid',
  };
  return statusLabels[status] || status;
}

/**
 * Check if a subscription is in a trial period.
 */
export function isInTrialPeriod(trialStart?: Date | null, trialEnd?: Date | null): boolean {
  if (!trialStart || !trialEnd) return false;
  const now = new Date();
  return now >= trialStart && now <= trialEnd;
}

// ============================================================================
// STRIPE API ACTIONS (to be used by route handlers)
// ============================================================================

/**
 * Create a subscription for a user.
 * 
 * @param customerId - Stripe Customer ID
 * @param priceId - Stripe Price ID to subscribe to
 * @returns Created Subscription object
 */
export async function createCustomerSubscription(
  customerId: string,
  priceId: string,
  trialDays?: number
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();

  return await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    ...(trialDays ? { trial_period_days: trialDays } : {}),
    expand: ['latest_invoice', 'subscription_payment_behavior'],
  });
}

/**
 * Cancel a subscription — either immediately or at the end of current period.
 */
export async function cancelSubscription(
  subscriptionId: string,
  immediate = false
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();

  return await stripe.subscriptions.cancel(subscriptionId, {
    invoice_now: immediate,
    prorate: !immediate,
  });
}

/**
 * Update the quantity (e.g., seat count) on a subscription.
 */
export async function updateSubscriptionQuantity(
  subscriptionId: string,
  priceId: string,
  quantity: number
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();

  return await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: subscriptionId, quantity }], // Stripe requires the subscription line item ID
    prorate: true,
  });
}

/**
 * Retrieve a customer's active subscriptions.
 */
export async function getCustomerSubscriptions(
  customerId: string,
  status: 'active' | 'trialing' = 'active'
): Promise<Stripe.Subscription[]> {
  const stripe = getStripeClient();

  const result = await stripe.subscriptions.list({
    customer: customerId,
    status,
  });

  return result.data;
}

/**
 * Generate a Stripe Checkout session for subscription upgrades/downgrades.
 */
export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();

  return await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });
}

// ============================================================================
// EXPORTS FOR TESTING / DEBUGGING
// ============================================================================

export { stripeInstance }; // For testing — the cached instance (may be null)
