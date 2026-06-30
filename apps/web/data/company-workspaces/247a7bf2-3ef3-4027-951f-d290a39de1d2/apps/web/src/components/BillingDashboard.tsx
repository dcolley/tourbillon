/**
 * Billing Dashboard Page Component (TOUR-152)
 * 
 * Displays subscription status, plan details, billing history,
 * and options to upgrade/downgrade/cancel.
 */

'use client';

import React, { useState, useEffect } from 'react';
import { PricingTable, PlanChangeModal, PRICING_TIERS } from './PricingTable';

// ============================================================================
// TYPES
// ============================================================================

interface SubscriptionStatus {
  plan: string | null;
  status: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd?: Date | null;
  hasTrialEnded?: boolean;
  seats?: number;
}

interface InvoiceItem {
  id: string;
  invoiceId: string;
  amountDue: number;
  currency: string;
  status: string;
  issuedAt: Date | null;
  paidAt: Date | null;
  pdfUrl?: string;
  hostedInvoiceUrl?: string;
}

// ============================================================================
// BILLING DASHBOARD PAGE COMPONENT
// ============================================================================

export default function BillingDashboardPage() {
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);

  // Fetch subscription status on mount
  useEffect(() => {
    fetchSubscription();
    fetchInvoices();
  }, []);

  async function fetchSubscription() {
    try {
      setLoading(true);
      const response = await fetch('/api/billing/subscription');
      if (!response.ok) throw new Error('Failed to load subscription');
      const data = await response.json();
      setSubscription(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load billing information');
    } finally {
      setLoading(false);
    }
  }

  async function fetchInvoices() {
    try {
      const response = await fetch('/api/billing/invoices?limit=10');
      if (!response.ok) throw new Error('Failed to load invoices');
      const data = await response.json();
      setInvoices(data.invoices || []);
    } catch (err: any) {
      console.error('Error fetching invoices:', err);
    }
  }

  async function handleUpgrade(tier: typeof PRICING_TIERS[0]) {
    try {
      const response = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: tier.stripePriceId,
          customerId: '', // Would come from session in production
          successUrl: `${window.location.origin}/billing?success=true`,
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      });

      if (!response.ok) throw new Error('Failed to create checkout session');
      
      const { url } = await response.json();
      if (url) window.location.href = url; // Redirect to Stripe Checkout
    } catch (err: any) {
      setError(err.message || 'Failed to process plan change');
    }
  }

  async function handleCancelSubscription() {
    if (!confirm('Are you sure you want to cancel your subscription? You will lose access to premium features at the end of your billing period.')) {
      return;
    }

    try {
      const response = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: '' }), // Would come from session in production
      });

      if (!response.ok) throw new Error('Failed to cancel subscription');
      
      await fetchSubscription(); // Refresh status
    } catch (err: any) {
      setError(err.message || 'Failed to cancel subscription');
    }
  }

  const currentTier = PRICING_TIERS.find(t => t.id === subscription?.plan) || PRICING_TIERS[0];
  const isProOrEnterprise = subscription?.plan !== 'free';

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-2">Billing & Subscription</h1>
        <p className="text-gray-500 dark:text-gray-400">
          Manage your subscription plan, billing information, and invoices.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-lg">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="text-center py-12">
          <svg className="animate-spin h-8 w-8 mx-auto text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="mt-4 text-gray-500">Loading billing information...</p>
        </div>
      ) : (
        <>
          {/* Current Plan Card */}
          {!subscription?.plan && !isProOrEnterprise ? (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Your Current Plan</h2>
              <p className="text-gray-500 mb-4">You are currently on the Free plan.</p>
              <button
                onClick={() => setShowPlanModal(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium"
              >
                Upgrade to Pro
              </button>
            </div>
          ) : (
            <div className={`rounded-lg border p-6 ${isProOrEnterprise ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'}`}>
              <h2 className="text-xl font-bold mb-4">Your Current Plan</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Plan</p>
                  <p className="font-semibold text-lg">{currentTier.name}</p>
                  
                  {isProOrEnterprise && (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">Status</p>
                      <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                        subscription?.status === 'active' 
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                          : subscription?.status === 'past_due'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300'
                      }`}>
                        {subscription?.status || 'Unknown'}
                      </span>
                    </>
                  )}
                </div>

                <div>
                  {isProOrEnterprise && subscription?.currentPeriodEnd ? (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">Next Billing Date</p>
                      <p className="font-semibold">{new Date(subscription.currentPeriodEnd).toLocaleDateString()}</p>
                      
                      {subscription.cancelAtPeriodEnd && (
                        <p className="text-yellow-600 text-sm mt-2">
                          ⚠️ Your subscription will be canceled at the end of this billing period.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-gray-500 text-sm italic">No active subscription</p>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              {isProOrEnterprise && !subscription?.cancelAtPeriodEnd && (
                <div className="mt-6 flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => setShowPlanModal(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium"
                  >
                    {subscription?.plan === 'enterprise' ? 'Downgrade Plan' : 'Upgrade Plan'}
                  </button>
                  
                  <button
                    onClick={handleCancelSubscription}
                    className="border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 px-4 py-2 rounded-lg font-medium"
                  >
                    Cancel Subscription
                  </button>
                </div>
              )}

              {subscription?.cancelAtPeriodEnd && (
                <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500">
                    You can resubscribe at any time before your current period ends.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Pricing Table (for upgrades/downgrades) */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-xl font-bold mb-6">Available Plans</h2>
            <PricingTable onPlanSelect={handleUpgrade} currentPlan={subscription?.plan || 'free'} />
          </div>

          {/* Invoice History */}
          {invoices.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-xl font-bold mb-4">Invoice History</h2>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-3 font-medium text-sm text-gray-500">Invoice</th>
                      <th className="pb-3 font-medium text-sm text-gray-500">Date</th>
                      <th className="pb-3 font-medium text-sm text-gray-500">Amount</th>
                      <th className="pb-3 font-medium text-sm text-gray-500">Status</th>
                      <th className="pb-3 font-medium text-sm text-gray-500"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <td className="py-3">
                          <span className="font-mono text-sm">{invoice.invoiceId}</span>
                        </td>
                        <td className="py-3">
                          {invoice.issuedAt 
                            ? new Date(invoice.issuedAt).toLocaleDateString()
                            : 'N/A'
                          }
                        </td>
                        <td className="py-3 font-medium">
                          ${(invoice.amountDue / 100).toFixed(2)}
                        </td>
                        <td className="py-3">
                          <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${
                            invoice.status === 'paid'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                              : invoice.status === 'unpaid'
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
                              : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                          }`}>
                            {invoice.status}
                          </span>
                        </td>
                        <td className="py-3">
                          {invoice.hostedInvoiceUrl && (
                            <a
                              href={invoice.hostedInvoiceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                            >
                              Download PDF
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Payment Methods (placeholder) */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-xl font-bold mb-4">Payment Method</h2>
            <p className="text-gray-500 text-sm italic">
              Payment method management coming soon. Contact support for changes.
            </p>
          </div>
        </>
      )}

      {/* Plan Change Modal */}
      <PlanChangeModal
        isOpen={showPlanModal}
        onClose={() => setShowPlanModal(false)}
        currentPlan={currentTier}
        availablePlans={PRICING_TIERS.filter(t => t.id !== 'free')} // Can only upgrade/downgrade to paid plans
        onConfirm={handleUpgrade}
      />
    </div>
  );
}
