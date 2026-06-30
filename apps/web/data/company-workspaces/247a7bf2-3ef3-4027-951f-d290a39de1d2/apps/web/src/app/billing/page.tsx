/**
 * Billing Dashboard Page (TOUR-152)
 * Route: /billing
 */

import dynamic from 'next/dynamic';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Billing & Subscription | Tourbillon',
  description: 'Manage your subscription plan, billing information, and invoices.',
};

// Dynamically import the BillingDashboard component to avoid SSR issues with client-only code
const BillingDashboard = dynamic(() => import('@/components/BillingDashboard').then(mod => mod.default), {
  ssr: false,
});

export default function BillingPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <BillingDashboard />
    </div>
  );
}
