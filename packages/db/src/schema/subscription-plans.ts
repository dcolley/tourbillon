/**
 * Subscription Plans table
 * Defines Free, Pro, and Enterprise tiers with their pricing and limits
 */

import { pgTable, text, integer, decimal, timestamp, boolean } from 'drizzle-orm/pg-core';

export const subscriptionPlans = pgTable('subscription_plans', {
  id: text('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(), // 'free', 'pro', 'enterprise'
  displayName: text('display_name').notNull(), // 'Free', 'Pro', 'Enterprise'
  stripePriceId: text('stripe_price_id'), // Stripe Price ID for metered/regular billing
  stripeProductId: text('stripe_product_id'), // Stripe Product ID
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull().default('0'), // Monthly price in USD
  currency: text('currency').notNull().default('usd'),
  interval: text('interval').notNull().default('month'), // 'month' or 'year'
  
  // Feature limits - Free tier
  maxApiCallsPerDay: integer('max_api_calls_per_day').notNull().default(100),
  maxGoals: integer('max_goals').notNull().default(5),
  maxMembers: integer('max_members').notNull().default(1),
  maxWorkspaceFiles: integer('max_workspace_files').notNull().default(50),
  
  // Pro tier limits (overridden when plan is pro)
  proMaxApiCallsPerDay: integer('pro_max_api_calls_per_day').default(10000),
  proMaxGoals: integer('pro_max_goals').default(100),
  proMaxMembers: integer('pro_max_members').default(5),
  proMaxWorkspaceFiles: integer('pro_max_workspace_files').default(500),
  
  // Enterprise tier limits (overridden when plan is enterprise)
  entMaxApiCallsPerDay: integer('ent_max_api_calls_per_day').default(-1), // -1 = unlimited
  entMaxGoals: integer('ent_max_goals').default(-1),
  entMaxMembers: integer('ent_max_members').default(-1),
  entMaxWorkspaceFiles: integer('ent_max_workspace_files').default(-1),

  // Feature flags
  includesAiAssistant: boolean('includes_ai_assistant').notNull().default(false),
  includesCustomBranding: boolean('includes_custom_branding').notNull().default(false),
  includesSso: boolean('includes_sso').notNull().default(false),
  includesPrioritySupport: boolean('includes_priority_support').notNull().default(false),
  
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
});
