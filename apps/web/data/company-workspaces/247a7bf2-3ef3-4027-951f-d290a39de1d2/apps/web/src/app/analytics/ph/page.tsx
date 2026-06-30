/**
 * Product Hunt Analytics Dashboard Page (TOUR-156)
 * Route: /analytics/ph
 */

import { Metadata } from 'next';
import dynamic from 'next/dynamic';

export const metadata: Metadata = {
  title: 'PH Launch Analytics | Tourbillon',
  description: 'Real-time analytics for the Product Hunt launch campaign.',
};

// Dynamically import to avoid SSR issues with client-only code
const PHAnalyticsDashboard = dynamic(() => 
  import('@/components/PHAnalyticsDashboard').then(mod => mod.default), 
  { ssr: false }
);

export default function PHAnalyticsPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <PHAnalyticsDashboard />
    </div>
  );
}
