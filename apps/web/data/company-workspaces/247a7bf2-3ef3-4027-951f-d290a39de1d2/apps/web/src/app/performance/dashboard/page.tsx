/**
 * Performance Monitoring Dashboard Page (TOUR-154)
 * Route: /performance/dashboard
 */

import { Metadata } from 'next';
import dynamic from 'next/dynamic';

export const metadata: Metadata = {
  title: 'Performance Dashboard | Tourbillon',
  description: 'Real-time SLO monitoring and performance metrics for the Tourbillon platform.',
};

// Dynamically import to avoid SSR issues with client-only code
const PerformanceDashboard = dynamic(() => 
  import('@/components/PerformanceDashboard').then(mod => mod.default), 
  { ssr: false }
);

export default function PerformancePage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <PerformanceDashboard />
    </div>
  );
}
