-- Tourbillon Billing Tables Migration (TOUR-150)
-- Adds subscription plans, subscriptions, and invoices tables for Stripe integration

-- Create enum types first
CREATE TYPE "public"."SubscriptionInterval" AS ENUM('month', 'year');
CREATE TYPE "public"."SubscriptionStatus" AS ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');

-- Subscription Plans (TOUR-150)
CREATE TABLE IF NOT EXISTS "SubscriptionPlan" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "stripePriceId" VARCHAR(255) UNIQUE NOT NULL,
    "stripeProductId" VARCHAR(255) UNIQUE NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "amount" INTEGER NOT NULL, -- Amount in cents (e.g., 1500 = $15.00)
    "currency" VARCHAR(3) DEFAULT 'usd',
    "interval" "SubscriptionInterval" DEFAULT 'month',
    "isActive" BOOLEAN DEFAULT true,
    "metadata" JSONB, -- Additional Stripe/plan metadata (features, limits, etc.)
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Subscriptions (TOUR-150)
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "subscriptionId" VARCHAR(255) UNIQUE NOT NULL, -- Stripe Subscription ID (sub_xxx)
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" DEFAULT 'incomplete',
    "currentPeriodStart" TIMESTAMP WITH TIME ZONE,
    "currentPeriodEnd" TIMESTAMP WITH TIME ZONE,
    "cancelAtPeriodEnd" BOOLEAN DEFAULT false,
    "canceledAt" TIMESTAMP WITH TIME ZONE,
    "cancellationReason" TEXT, -- User-provided reason for cancellation
    "trialStart" TIMESTAMP WITH TIME ZONE,
    "trialEnd" TIMESTAMP WITH TIME ZONE,
    "hasTrialEnded" BOOLEAN DEFAULT false,
    "seats" INTEGER DEFAULT 1, -- Number of team seats allocated
    "seatOverage" INTEGER DEFAULT 0, -- Seats beyond the plan limit
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Invoices (TOUR-150)
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "invoiceId" VARCHAR(255) UNIQUE NOT NULL, -- Stripe Invoice ID (in_xxx)
    "subscriptionId" UUID NOT NULL,
    "status" VARCHAR(50) DEFAULT 'draft', -- 'draft', 'open', 'paid', 'unpaid', 'void'
    "amountDue" INTEGER DEFAULT 0, -- Amount in cents
    "currency" VARCHAR(3) DEFAULT 'usd',
    "issuedAt" TIMESTAMP WITH TIME ZONE,
    "dueDate" TIMESTAMP WITH TIME ZONE,
    "paidAt" TIMESTAMP WITH TIME ZONE,
    "pdfUrl" TEXT, -- URL to download PDF of invoice
    "hostedInvoiceUrl" TEXT, -- Stripe-hosted invoice page URL
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Foreign Key Constraints
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
    
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" 
    FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
    
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" 
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT;

-- Indexes for performance (matching Prisma schema definitions)
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");
CREATE INDEX "Subscription_subscriptionId_idx" ON "Subscription"("subscriptionId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
CREATE INDEX "Invoice_userId_idx" ON "Invoice"("userId");
CREATE INDEX "Invoice_subscriptionId_idx" ON "Invoice"("subscriptionId");
CREATE INDEX "Invoice_invoiceId_idx" ON "Invoice"("invoiceId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
