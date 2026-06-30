import { pgTable, text, integer, timestamp, boolean, json } from 'drizzle-orm/pg-core';

/**
 * Subscription Plan table — maps to Stripe Price/Product metadata.
 */
export const subscriptionPlans = pgTable('subscription_plans', {
  id: text('id').primaryKey().defaultRandom(),
  stripePriceId: text('stripe_price_id').notNull().unique(),
  stripeProductId: text('stripe_product_id'),
  name: text('name').notNull(),
  description: text('description'),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull().default('usd'),
  interval: text('interval').notNull(), // 'month' | 'year'
  isActive: boolean('is_active').notNull().default(true),
  metadata: json('metadata').$type<{ stripeProductId?: string; features?: string[]; limits?: Record<string, unknown> }>(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

/**
 * Subscription table — tracks user subscription state synced with Stripe.
 */
export const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  subscriptionId: text('subscription_id').notNull().unique(), // Stripe Subscription ID
  planId: text('plan_id').references(() => subscriptionPlans.id),
  status: text('status').notNull(), // 'active' | 'trialing' | 'past_due' | 'canceled' | etc.
  currentPeriodStart: timestamp('current_period_start'),
  currentPeriodEnd: timestamp('current_period_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false),
  trialStart: timestamp('trial_start'),
  trialEnd: timestamp('trial_end'),
  hasTrialEnded: boolean('has_trial_ended').default(false),
  seats: integer('seats').notNull().default(1),
  canceledAt: timestamp('canceled_at'),
  cancellationReason: text('cancellation_reason'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

/**
 * Invoice table — tracks billing invoices from Stripe.
 */
export const invoices = pgTable('invoices', {
  id: text('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  invoiceId: text('invoice_id').notNull().unique(), // Stripe Invoice ID
  subscriptionId: text('subscription_id').references(() => subscriptions.id),
  status: text('status').notNull(), // 'paid' | 'unpaid' | 'pending' | etc.
  amountDue: integer('amount_due').notNull(), // in cents
  currency: text('currency').default('usd'),
  issuedAt: timestamp('issued_at'),
  dueDate: timestamp('due_date'),
  paidAt: timestamp('paid_at'),
  pdfUrl: text('pdf_url'),
  hostedInvoiceUrl: text('hosted_invoice_url'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

/**
 * Webhook Events table — for idempotency tracking.
 */
export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey().defaultRandom(),
  stripeEventId: text('stripe_event_id').notNull().unique(), // Stripe Event ID
  eventType: text('event_type').notNull(), // e.g., 'invoice.payment_succeeded'
  processedAt: timestamp('processed_at').defaultNow(),
});
