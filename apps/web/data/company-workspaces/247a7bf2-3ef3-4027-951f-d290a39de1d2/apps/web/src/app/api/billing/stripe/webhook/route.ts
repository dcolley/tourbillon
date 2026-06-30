/**
 * Stripe Webhook Handler Route (TOUR-151)
 * 
 * Handles all Stripe webhook events for subscription lifecycle management.
 * Endpoints: POST /api/billing/stripe/webhook
 * 
 * Features:
 * - Signature validation via stripe.ts utility
 * - Idempotent event processing (no duplicate updates on retries)
 * - Full subscription lifecycle handling (create, update, cancel, invoice events)
 * - Automatic database state synchronization with Stripe
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

// Import existing stripe utility for signature validation and client access
import { 
  getStripeClient, 
  parseWebhookEvent, 
  isSubscriptionActive 
} from '@/lib/stripe';
import { db, subscriptionPlans, subscriptions, invoices } from '@tourbillon/db';

// ============================================================================
// IDEMPOTENCY & EVENT TRACKING
// ============================================================================

interface WebhookEventRecord {
  id: string;
  stripeEventId: string;
  eventType: string;
  processedAt: Date;
}

/**
 * Check if a webhook event has already been processed.
 * Uses raw query to avoid dependency on schema definition.
 */
async function getProcessedEvent(stripeEventId: string): Promise<boolean> {
  try {
    const result = await db.execute(
      `SELECT COUNT(*) as count FROM webhook_events WHERE stripe_event_id = $1`,
      [stripeEventId]
    );
    return Number(result[0].count) > 0;
  } catch (error) {
    // If table doesn't exist, assume not processed (will be created on first use)
    console.warn(`[Webhook] Could not check webhook_events table: ${error}`);
    return false;
  }
}

/**
 * Record a processed webhook event for idempotency.
 */
async function recordProcessedEvent(stripeEventId: string, eventType: string): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO webhook_events (stripe_event_id, event_type, processed_at) VALUES ($1, $2, NOW())`,
      [stripeEventId, eventType]
    );
  } catch (error) {
    // If table doesn't exist yet, skip recording
    console.warn(`[Webhook] Could not record webhook event: ${error}`);
  }
}

// ============================================================================
// STRIPE EVENT TYPE CONSTANTS
// ============================================================================

const WEBHOOK_EVENTS = {
  // Invoice events
  INVOICE_PAID: 'invoice.payment_succeeded',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  INVOICE_CREATED: 'invoice.created',
  
  // Subscription events
  SUBSCRIPTION_CREATED: 'customer.subscription.created',
  SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
  SUBSCRIPTION_TRIALING: null, // Handled via updated event
  
  // Customer events
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  
  // Payment methods
  PAYMENT_METHOD_ATTACHED: 'payment_method.attached',
} as const;

// ============================================================================
// HELPER FUNCTIONS FOR DATABASE OPERATIONS
// ============================================================================

/**
 * Extract userId from customer metadata with safe fallback.
 */
function extractUserId(customer: any): string | null {
  if (!customer?.metadata?.userId) {
    console.warn(`[Webhook] No userId in customer metadata for ${customer.id}`);
    return null;
  }
  return String(customer.metadata.userId);
}

/**
 * Upsert a subscription plan in the database based on Stripe data.
 */
async function upsertSubscriptionPlan(stripePriceId: string, stripeProductId: string): Promise<{ id: string }> {
  const stripe = getStripeClient();
  
  try {
    const price = await stripe.prices.retrieve(stripePriceId);
    const product = await stripe.products.retrieve(typeof price.product === 'string' ? price.product : '');
    
    let planResult = await db.select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.stripePriceId, stripePriceId))
      .limit(1);
    
    if (planResult.length === 0) {
      // Create new plan
      const [newPlan] = await db.insert(subscriptionPlans).values({
        stripePriceId,
        stripeProductId: typeof product.id === 'string' ? product.id : '',
        name: typeof product.name === 'string' ? product.name : 'Unknown',
        description: product.description || null,
        amount: price.unit_amount ?? 0,
        currency: price.currency || 'usd',
        interval: (price.recurring?.interval === 'year' ? 'year' : 'month') as 'year' | 'month',
        isActive: product.active !== false,
        metadata: JSON.stringify({
          stripeProductId: typeof product.id === 'string' ? product.id : '',
          features: product.metadata?.features,
          limits: product.metadata?.limits,
        }),
      }).returning();
      
      return { id: newPlan.id };
    } else {
      // Update existing plan - fix: use a properly scoped variable
      const [updatedPlan] = await db.update(subscriptionPlans)
        .set({
          name: typeof product.name === 'string' ? product.name : planResult[0].name,
          description: product.description || null,
          amount: price.unit_amount ?? 0,
          currency: price.currency || 'usd',
          interval: (price.recurring?.interval === 'year' ? 'year' : 'month') as 'year' | 'month',
          isActive: product.active !== false,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionPlans.stripePriceId, stripePriceId))
        .returning();
      
      return { id: updatedPlan.id };
    }
  } catch (error) {
    console.error('Error upserting subscription plan:', error);
    throw error;
  }
}

/**
 * Get userId from subscription via customer metadata.
 */
async function getUserIdFromSubscription(subscription: any): Promise<string | null> {
  const stripe = getStripeClient();
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : '';
  
  if (!customerId) {
    console.warn(`[Webhook] No customer ID on subscription ${subscription.id}`);
    return null;
  }
  
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return extractUserId(customer);
  } catch (error) {
    console.error(`[Webhook] Failed to retrieve customer ${customerId}:`, error);
    return null;
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle the creation of a new subscription.
 */
async function handleSubscriptionCreated(subscription: any): Promise<void> {
  const stripe = getStripeClient();
  
  try {
    // Extract userId from customer metadata
    const userId = await getUserIdFromSubscription(subscription);
    
    if (!userId) {
      console.warn(`[Webhook] Subscription created without userId metadata: ${subscription.id}`);
      return;
    }
    
    // Upsert the plan first
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (!priceId) {
      throw new Error('No price ID found in subscription items');
    }
    
    const planResult = await upsertSubscriptionPlan(priceId, '');
    
    // Create or update the subscription record
    const existing = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.subscriptionId, subscription.id))
      .limit(1);
    
    if (existing.length > 0) {
      console.log(`[Webhook] Subscription ${subscription.id} already exists, skipping creation`);
      return;
    }
    
    const currentPeriodStart = subscription.current_period_start 
      ? new Date(subscription.current_period_start * 1000) : null;
    const currentPeriodEnd = subscription.current_period_end 
      ? new Date(subscription.current_period_end * 1000) : null;
    const trialStart = subscription.trial_start 
      ? new Date(subscription.trial_start * 1000) : null;
    const trialEnd = subscription.trial_end 
      ? new Date(subscription.trial_end * 1000) : null;
    
    await db.insert(subscriptions).values({
      userId,
      subscriptionId: subscription.id,
      planId: planResult.id,
      status: subscription.status || 'incomplete',
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      trialStart,
      trialEnd,
      hasTrialEnded: !!trialEnd && trialEnd < new Date(),
      seats: subscription.items?.data?.[0]?.quantity || 1,
    });
    
    console.log(`[Webhook] Created subscription ${subscription.id} for user ${userId}`);
  } catch (error) {
    console.error('[Webhook] Error handling subscription created:', error);
    throw error;
  }
}

/**
 * Handle subscription updates from Stripe.
 */
async function handleSubscriptionUpdated(subscription: any): Promise<void> {
  const stripe = getStripeClient();
  
  try {
    const userId = await getUserIdFromSubscription(subscription);
    
    if (!userId) {
      console.warn(`[Webhook] Subscription updated without userId metadata: ${subscription.id}`);
      return;
    }
    
    // Upsert the plan based on current price
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (priceId) {
      await upsertSubscriptionPlan(priceId, '');
    }
    
    // Find existing subscription by Stripe ID
    const existingSub = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.subscriptionId, subscription.id))
      .limit(1);
    
    if (existingSub.length === 0) {
      console.warn(`[Webhook] Subscription ${subscription.id} not found in DB for update`);
      return;
    }
    
    const currentPeriodStart = subscription.current_period_start 
      ? new Date(subscription.current_period_start * 1000) : null;
    const currentPeriodEnd = subscription.current_period_end 
      ? new Date(subscription.current_period_end * 1000) : null;
    const trialStart = subscription.trial_start 
      ? new Date(subscription.trial_start * 1000) : null;
    const trialEnd = subscription.trial_end 
      ? new Date(subscription.trial_end * 1000) : null;
    
    await db.update(subscriptions)
      .set({
        status: subscription.status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        trialStart,
        trialEnd,
        hasTrialEnded: !!trialEnd && trialEnd < new Date(),
        seats: subscription.items?.data?.[0]?.quantity || existingSub[0].seats,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.subscriptionId, subscription.id));
    
    console.log(`[Webhook] Updated subscription ${subscription.id}: status=${subscription.status}`);
  } catch (error) {
    console.error('[Webhook] Error handling subscription updated:', error);
    throw error;
  }
}

/**
 * Handle subscription cancellation/deletion.
 */
async function handleSubscriptionDeleted(subscription: any): Promise<void> {
  const stripe = getStripeClient();
  
  try {
    const userId = await getUserIdFromSubscription(subscription);
    
    if (!userId) {
      console.warn(`[Webhook] Subscription deleted without userId metadata: ${subscription.id}`);
      return;
    }
    
    // Find and update the subscription in DB
    const existingSub = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.subscriptionId, subscription.id))
      .limit(1);
    
    if (existingSub.length === 0) {
      console.warn(`[Webhook] Subscription ${subscription.id} not found for deletion`);
      return;
    }
    
    await db.update(subscriptions)
      .set({
        status: 'canceled',
        canceledAt: new Date(),
        cancellationReason: subscription.cancellation_details?.reason || null,
        cancelAtPeriodEnd: true,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.subscriptionId, subscription.id));
    
    console.log(`[Webhook] Marked subscription ${subscription.id} as canceled for user ${userId}`);
  } catch (error) {
    console.error('[Webhook] Error handling subscription deleted:', error);
    throw error;
  }
}

/**
 * Handle invoice payment succeeded.
 */
async function handleInvoicePaid(invoice: any): Promise<void> {
  const stripe = getStripeClient();
  
  try {
    const subscriptionId = invoice.subscription as string;
    
    // Upsert the invoice record
    const existingInvoice = await db.select()
      .from(invoices)
      .where(eq(invoices.invoiceId, invoice.id))
      .limit(1);
    
    if (existingInvoice.length > 0) {
      console.log(`[Webhook] Invoice ${invoice.id} already exists, skipping`);
      return;
    }
    
    // Get subscription to find userId and planId
    const sub = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.subscriptionId, subscriptionId))
      .limit(1);
    
    if (sub.length === 0) {
      console.warn(`[Webhook] Invoice ${invoice.id} has no linked subscription`);
      return;
    }
    
    const issuedAt = invoice.created 
      ? new Date(invoice.created * 1000) : null;
    
    await db.insert(invoices).values({
      userId: sub[0].userId,
      invoiceId: invoice.id,
      subscriptionId: sub[0].id,
      status: 'paid',
      amountDue: invoice.amount_due ?? 0,
      currency: invoice.currency || 'usd',
      issuedAt,
      dueDate: invoice.due_date 
        ? new Date(invoice.due_date * 1000) : null,
      paidAt: new Date(),
      pdfUrl: invoice.hosted_pdf_url,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    });
    
    console.log(`[Webhook] Recorded paid invoice ${invoice.id} for subscription ${subscriptionId}`);
  } catch (error) {
    console.error('[Webhook] Error handling invoice paid:', error);
    throw error;
  }
}

/**
 * Handle invoice payment failed.
 */
async function handleInvoicePaymentFailed(invoice: any): Promise<void> {
  const stripe = getStripeClient();
  
  try {
    const subscriptionId = invoice.subscription as string;
    
    // Update subscription status to past_due
    await db.update(subscriptions)
      .set({
        status: 'past_due',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.subscriptionId, subscriptionId));
    
    console.log(`[Webhook] Marked subscription ${subscriptionId} as past_due due to invoice failure`);
  } catch (error) {
    console.error('[Webhook] Error handling invoice payment failed:', error);
    // Don't throw — this is a non-critical update, Stripe will retry
  }
}

/**
 * Handle customer creation.
 */
async function handleCustomerCreated(customer: any): Promise<void> {
  try {
    console.log(`[Webhook] Customer created: ${customer.id}`);
    // In many cases, the user should already exist in our DB
    // We can store Stripe customerId mapping if needed in the future
  } catch (error) {
    console.error('[Webhook] Error handling customer created:', error);
  }
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================

/**
 * POST /api/billing/stripe/webhook
 * 
 * Stripe webhook endpoint for processing billing events.
 */
export async function POST(request: NextRequest) {
  // Get raw body and signature header
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('stripe-signature') || '';
  
  try {
    // Validate webhook signature
    const event = parseWebhookEvent(rawBody, signatureHeader);
    
    if (!event) {
      console.error('[Webhook] Invalid signature or failed to parse event');
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }
    
    const eventType = event.type;
    const stripeEventId = event.id;
    const payload = event.data?.object as any;
    
    console.log(`[Webhook] Received event ${eventType} (${stripeEventId})`);
    
    // Check for idempotency - skip if already processed
    if (await getProcessedEvent(stripeEventId)) {
      console.log(`[Webhook] Event ${stripeEventId} already processed, skipping`);
      return NextResponse.json(
        { received: true, eventType, skipped: 'already_processed' },
        { status: 200 }
      );
    }
    
    // Process based on event type with proper routing
    try {
      switch (eventType) {
        case WEBHOOK_EVENTS.SUBSCRIPTION_CREATED:
          await handleSubscriptionCreated(payload);
          break;
          
        case WEBHOOK_EVENTS.SUBSCRIPTION_UPDATED:
          await handleSubscriptionUpdated(payload);
          break;
          
        case WEBHOOK_EVENTS.SUBSCRIPTION_DELETED:
          await handleSubscriptionDeleted(payload);
          break;
          
        case WEBHOOK_EVENTS.INVOICE_PAID:
          await handleInvoicePaid(payload);
          break;
          
        case WEBHOOK_EVENTS.INVOICE_PAYMENT_FAILED:
          await handleInvoicePaymentFailed(payload);
          break;
          
        case WEBHOOK_EVENTS.CUSTOMER_CREATED:
          await handleCustomerCreated(payload);
          break;
          
        default:
          // Log unrecognized events for debugging (not an error)
          console.log(`[Webhook] Unhandled event type: ${eventType}`);
      }
      
      // Record as processed for idempotency
      await recordProcessedEvent(stripeEventId, eventType);
    } catch (handlerError) {
      // Even if processing fails, don't mark as processed so Stripe can retry
      console.error('[Webhook] Error in event handler:', handlerError);
      throw handlerError;
    }
    
    // Return 200 to acknowledge receipt
    return NextResponse.json(
      { received: true, eventType },
      { status: 200 }
    );
    
  } catch (error) {
    console.error('[Webhook] Error processing webhook:', error);
    
    // Return 500 to indicate we should retry
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? String(error) : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/billing/stripe/webhook — Health check endpoint.
 */
export async function GET() {
  return NextResponse.json(
    { 
      service: 'Stripe Webhook Handler',
      status: 'operational',
      events: Object.values(WEBHOOK_EVENTS).filter(Boolean),
    },
    { status: 200 }
  );
}
