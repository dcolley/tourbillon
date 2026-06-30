/**
 * Product Hunt UTM Tracking Hook (TOUR-156)
 * 
 * Automatically detects and tracks Product Hunt referral traffic
 * via UTM parameters on landing page visits.
 * 
 * Usage in any React component:
 *   usePHUTMTracking(); // Called automatically on mount
 */

'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/lib/mixpanel/server';

// ============================================================================
// TYPES & CONFIG
// ============================================================================

interface UTMParams {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
}

const PH_CONFIG = {
  source: 'producthunt',
  campaign: 'ph-launch-2026-q4',
  phDomain: 'producthunt.com',
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract UTM parameters from the current URL.
 */
function extractUTMParams(): UTMParams {
  if (typeof window === 'undefined') {
    return { source: null, medium: null, campaign: null, content: null };
  }

  const url = new URL(window.location.href);
  
  return {
    source: url.searchParams.get('utm_source'),
    medium: url.searchParams.get('utm_medium'),
    campaign: url.searchParams.get('utm_campaign'),
    content: url.searchParams.get('utm_content'),
  };
}

/**
 * Check if this is a Product Hunt referral based on UTM params or referrer.
 */
function isPHReferral(utmParams: UTMParams): boolean {
  // Check UTM source first
  if (utmParams.source?.toLowerCase() === PH_CONFIG.source.toLowerCase()) {
    return true;
  }
  
  // Check referrer as fallback
  if (typeof document !== 'undefined') {
    const referrer = document.referrer.toLowerCase();
    if (referrer.includes(PH_CONFIG.phDomain)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Track a PH referral visit.
 */
async function trackPHReferral(utmParams: UTMParams): Promise<void> {
  try {
    // Track via server endpoint (will store in-memory for dashboard)
    const response = await fetch(`/api/analytics/ph?${new URLSearchParams({
      utm_source: utmParams.source || '',
      utm_medium: utmParams.medium || '',
      utm_campaign: utmParams.campaign || '',
      utm_content: utmParams.content || '',
    }).toString()}`, {
      method: 'GET',
    });

    // Also track via Mixpanel if available
    await trackEvent({
      distinct_id: crypto.randomUUID(), // Anonymous session ID
      event_name: 'PH_Referral_Visit',
      properties: {
        utm_source: utmParams.source,
        utm_medium: utmParams.medium,
        utm_campaign: utmParams.campaign,
        utm_content: utmParams.content,
        landing_page: window.location.href,
        referrer: PH_CONFIG.phDomain,
      },
    }).catch(() => {
      // Silently fail if Mixpanel not configured
    });

  } catch (error) {
    console.warn('[PH Tracking] Failed to track referral:', error);
  }
}

/**
 * Remove UTM parameters from the URL after tracking (clean URL).
 */
function cleanUTMFromURL(): void {
  if (typeof window === 'undefined') return;
  
  const url = new URL(window.location.href);
  const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  
  let hasUTMs = false;
  utmParams.forEach(param => {
    if (url.searchParams.has(param)) {
      url.searchParams.delete(param);
      hasUTMs = true;
    }
  });

  // Only update history if we removed params and they weren't already clean
  if (hasUTMs && window.history.replaceState) {
    window.history.replaceState({}, '', url.toString());
  }
}

// ============================================================================
// CUSTOM HOOK
// ============================================================================

/**
 * Hook to automatically track Product Hunt referral traffic.
 * Call this in your layout or page component.
 */
export function usePHUTMTracking(): void {
  useEffect(() => {
    const utmParams = extractUTMParams();
    
    if (isPHReferral(utmParams)) {
      // Track the referral visit
      trackPHReferral(utmParams);
      
      // Clean UTM params from URL after tracking
      cleanUTMFromURL();
      
      console.log('[PH Tracking] Referral tracked:', utmParams);
    }
  }, []);
}

// ============================================================================
// EXPORTS FOR TESTING / DEBUGGING
// ============================================================================

export { extractUTMParams, isPHReferral };
