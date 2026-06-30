/**
 * Pricing Page (TOUR-152)
 * Route: /pricing
 */

'use client';

import React, { useState } from 'react';
import { PricingTable, PlanChangeModal, PRICING_TIERS } from '@/components/PricingTable';

export default function PricingPage() {
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [selectedTier, setSelectedTier] = useState<typeof PRICING_TIERS[0] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpgrade(tier: typeof PRICING_TIERS[0]) {
    try {
      setLoading(true);
      setError(null);

      // In production, get customer ID from session/auth
      const response = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: tier.stripePriceId,
          customerId: '', // Would come from auth context in production
          successUrl: `${window.location.origin}/billing?success=true`,
          cancelUrl: `${window.location.origin}/pricing?canceled=true`,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create checkout session');
      }

      const result = await response.json();
      
      // Redirect to Stripe Checkout
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err: any) {
      setError(err.message || 'Failed to process plan change');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Hero Section */}
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 text-white py-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-5xl font-bold mb-4">Choose Your Plan</h1>
          <p className="text-xl text-blue-100 max-w-2xl mx-auto">
            Start free and scale as you grow. No hidden fees, cancel anytime.
          </p>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-lg">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-4 underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Pricing Table */}
      <div className="max-w-6xl mx-auto px-4 py-12">
        <PricingTable onPlanSelect={(tier) => {
          if (tier.id !== 'free') {
            setSelectedTier(tier);
            setShowPlanModal(true);
          }
        }} />

        {/* FAQ Section */}
        <div className="mt-16 max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-8">Frequently Asked Questions</h2>

          <div className="space-y-4">
            {[
              { q: 'Can I switch plans at any time?', a: 'Yes! You can upgrade or downgrade your plan at any time. Changes take effect immediately with prorated billing.' },
              { q: 'Is there a free trial for Pro or Enterprise?', a: "We offer a 14-day free trial for both Pro and Enterprise plans. No credit card required to start." },
              { q: 'What payment methods do you accept?', a: 'We accept all major credit cards (Visa, Mastercard, American Express) through Stripe.' },
              { q: 'Can I cancel my subscription?', a: 'Yes, you can cancel anytime from your billing dashboard. Your access continues until the end of the current billing period.' },
            ].map((faq, index) => (
              <div key={index} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
                <h3 className="font-semibold text-lg mb-2">{faq.q}</h3>
                <p className="text-gray-600 dark:text-gray-400">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Contact Section */}
        <div className="mt-12 text-center">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Have questions about our pricing?{' '}
            <a href="/contact" className="text-blue-600 hover:underline font-medium">
              Contact us
            </a>
          </p>
        </div>
      </div>

      {/* Plan Change Modal */}
      {selectedTier && (
        <PlanChangeModal
          isOpen={showPlanModal}
          onClose={() => setShowPlanModal(false)}
          currentPlan={{ id: 'free', name: 'Free', price: 0, description: '', features: [] }}
          availablePlans={[selectedTier]}
          onConfirm={(tier) => {
            handleUpgrade(tier);
          }}
        />
      )}

      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 text-center">
            <svg className="animate-spin h-8 w-8 mx-auto text-blue-500 mb-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-gray-600 dark:text-gray-300 font-medium">Redirecting to Stripe...</p>
          </div>
        </div>
      )}
    </div>
  );
}
