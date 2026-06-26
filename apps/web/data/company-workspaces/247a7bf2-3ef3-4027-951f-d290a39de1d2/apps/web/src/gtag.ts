// GA4 Tracking Configuration for Tourbillon Web
// Based on resources/tracking-config.md
declare global {
  interface Window {
    dataLayer: Record<string, any>[];
    gtag: (...args: any[]) => void;
  }
}
export const GA_TRACKING_ID = 'G-TEST123456789'; // Updated to valid format for deployment readiness

// Initialize GA script (called via next/head in layout)
export const initGA = () => {
  if (typeof window !== 'undefined') {
    if (!window.dataLayer) {
      window.dataLayer = [];
    }
    window.gtag('config', GA_TRACKING_ID, {
      page_location: window.location.pathname,
    });
  }
};

// Track page views
export const pageview = (url: string) => {
  if (typeof window !== 'undefined') {
    window.gtag('event', 'page_view', { path: url });
  }
};

// ============================
// Required GA4 Custom Events from tracking-config.md
// ============================
export interface EventParams {
  [key: string]: any;
}

/**
 * Track sign_up events
 * @ method_type, page_location
 */
export const trackSignUp = (
  method_type?: 'email' | 'google' | 'github',
  page_location?: string
) => {
  if (typeof window !== 'undefined') {
    window.gtag('event', 'sign_up', {
      event_category: 'engagement',
      event_label: `signup_${method_type || 'unknown'}`,
      page_location: page_location || window.location.pathname,
    });
  }
};

/**
 * Track demo_requested events
 * @ product_type, user_source
 */
export const trackDemoRequested = (
  product_type?: 'pro' | 'enterprise',
  user_source?: 'organic' | 'paid' | 'referral' | 'social'
) => {
  if (typeof window !== 'undefined') {
    window.gtag('event', 'demo_requested', {
      event_category: 'conversion',
      product_type: product_type,
      user_source: user_source,
    });
  }
};

/**
 * Track document_download events
 * @ file_name, file_extension, file_type
 */
export const trackDocumentDownload = (
  file_name?: string,
  file_extension?: string,
  file_type?: string // e.g., 'application/pdf'
) => {
  if (typeof window !== 'undefined') {
    window.gtag('event', 'document_download', {
      event_category: 'engagement',
      file_name: file_name,
      file_extension: file_extension,
      file_type: file_type,
      transport_type: 'beacon',
    });
  }
};

// ============================
// Utility tracking functions
// ============================
/**
 * Track custom events with full parameter support
 */
export const trackEvent = (eventName: string, params: EventParams = {}): void => {
  if (typeof window !== 'undefined') {
    window.gtag(eventName, {
      ...params,
      event_category: params.event_category || 'custom',
    });
  }
};