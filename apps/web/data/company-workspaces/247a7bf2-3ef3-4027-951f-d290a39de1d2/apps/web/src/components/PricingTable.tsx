'use client';

import React, { useState } from 'react';

// ============================================================================
// PRICING TIERS DEFINITION (Free, Pro, Enterprise)
// ============================================================================

interface PricingTier {
  id: string;
  name: string;
  price: number; // Monthly price in USD
  description: string;
  features: string[];
  highlighted?: boolean;
  stripePriceId?: string;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    description: 'Perfect for getting started with Tourbillon',
    features: [
      'Up to 5 projects',
      'Basic task management',
      'Personal dashboard',
      'Community support',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 15,
    description: 'For individuals and small teams who need more power',
    features: [
      'Unlimited projects',
      'Advanced analytics & reporting',
      'Team collaboration (up to 10 seats)',
      'Priority email support',
      'Custom integrations',
      'Export data to CSV/PDF',
    ],
    highlighted: true, // This will be the default recommended plan
    stripePriceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID || '',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 49,
    description: 'For organizations that need advanced controls and support',
    features: [
      'Everything in Pro',
      'Unlimited seats',
      'SSO/SAML authentication',
      'Advanced security & compliance',
      'Dedicated account manager',
      '24/7 phone support',
      'Custom SLA',
      'Audit logs & data retention policies',
    ],
    stripePriceId: process.env.NEXT_PUBLIC_STRIPE_ENTERPRISE_PRICE_ID || '',
  },
];

// ============================================================================
// PRICING TABLE COMPONENT
// ============================================================================

interface PricingTableProps {
  onPlanSelect?: (tier: PricingTier) => void;
  currentPlan?: string; // 'free', 'pro', or 'enterprise'
}

export function PricingTable({ onPlanSelect, currentPlan }: PricingTableProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto p-4">
      {PRICING_TIERS.map((tier) => (
        <PricingCard key={tier.id} tier={tier} currentPlan={currentPlan} onSelect={onPlanSelect} />
      ))}
    </div>
  );
}

// ============================================================================
// INDIVIDUAL PRICING CARD COMPONENT
// ============================================================================

interface PricingCardProps {
  tier: PricingTier;
  currentPlan?: string;
  onSelect?: (tier: PricingTier) => void;
}

function PricingCard({ tier, currentPlan, onSelect }: PricingCardProps) {
  const isCurrentPlan = currentPlan === tier.id;
  const isHighlighted = tier.highlighted && !isCurrentPlan;
  const isFree = tier.id === 'free';

  return (
    <div className={`relative rounded-lg border-2 p-6 flex flex-col transition-all hover:shadow-lg ${
      isHighlighted
        ? 'border-blue-500 shadow-md'
        : isCurrentPlan
        ? 'border-green-500 bg-green-50 dark:bg-green-950/20'
        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
    }`}>
      {isHighlighted && (
        <span className="absolute -top-3 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white px-4 py-1 rounded-full text-sm font-medium">
          Most Popular
        </span>
      )}

      {isCurrentPlan && (
        <span className="absolute top-3 right-3 bg-green-500 text-white px-2 py-1 rounded-full text-xs font-medium">
          Current Plan
        </span>
      )}

      <div className="mb-4">
        <h3 className="text-xl font-bold mb-1">{tier.name}</h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">{tier.description}</p>
      </div>

      <div className="mb-6">
        {isFree ? (
          <span className="text-4xl font-bold">$0/mo</span>
        ) : (
          <>
            <span className="text-4xl font-bold">${tier.price}</span>
            <span className="text-gray-500 dark:text-gray-400">/mo</span>
          </>
        )}
      </div>

      <ul className="space-y-3 mb-6 flex-grow">
        {tier.features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2 text-sm">
            <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {!isCurrentPlan && (
        <button
          onClick={() => onSelect?.(tier)}
          disabled={!onSelect || isFree}
          className={`w-full py-2 px-4 rounded-lg font-medium transition-colors ${
            isFree
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
              : isHighlighted
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-gray-800 dark:bg-gray-600 hover:bg-gray-900 dark:hover:bg-gray-500 text-white'
          }`}
        >
          {isFree ? 'Current Plan' : `Choose ${tier.name}`}
        </button>
      )}

      {isCurrentPlan && (
        <span className="w-full py-2 px-4 rounded-lg font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-center">
          Active Subscription
        </span>
      )}
    </div>
  );
}

// ============================================================================
// UPGRADE/DOWNGRADE MODAL COMPONENT
// ============================================================================

interface PlanChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlan: PricingTier;
  availablePlans: PricingTier[];
  onConfirm: (tier: PricingTier) => void;
}

export function PlanChangeModal({ isOpen, onClose, currentPlan, availablePlans, onConfirm }: PlanChangeModalProps) {
  if (!isOpen) return null;

  const selectedPlan = availablePlans.find((p) => p.id !== 'free'); // Default to Pro for demo
  const [selectedTier, setSelectedTier] = useState<PricingTier>(selectedPlan!);

  const handleConfirm = () => {
    onConfirm(selectedTier);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg max-w-md w-full p-6 shadow-xl">
        <h2 className="text-xl font-bold mb-4">Change Plan</h2>

        <p className="text-gray-600 dark:text-gray-300 text-sm mb-4">
          Current: <strong>{currentPlan.name}</strong> (${currentPlan.price}/mo)
        </p>

        <div className="space-y-2 mb-6">
          {availablePlans.filter((p) => p.id !== currentPlan.id).map((plan) => (
            <button
              key={plan.id}
              onClick={() => setSelectedTier(plan)}
              className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                selectedTier.id === plan.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="font-medium">{plan.name}</span>
                <span className="text-sm text-gray-500">${plan.price}/mo</span>
              </div>
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2 px-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="flex-1 py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Confirm Change
          </button>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Changes take effect immediately. Prorated charges will apply.
        </p>
      </div>
    </div>
  );
}

export default PricingTable;
