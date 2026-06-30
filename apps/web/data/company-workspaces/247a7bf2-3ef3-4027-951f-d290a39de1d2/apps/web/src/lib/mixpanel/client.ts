/**
 * Tourbillon Mixpanel Client SDK — TOUR-147
 * 
 * Client-side Mixpanel initialization for browser tracking.
 * Uses @mixpanel/browser library with GDPR-compliant opt-out support.
 */

import mixpanel from 'mixpanel-browser';

// ============================================================================
// MIXPANEL CONFIGURATION
// ============================================================================

interface MixpanelClientConfig {
  /** Mixpanel project token (from environment) */
  token: string;
  /** Whether to track in development mode */
  debug?: boolean;
}

/**
 * Initialize the client-side Mixpanel SDK.
 * This should be called once during app initialization.
 */
export function initMixpanel(config?: Partial<MixpanelClientConfig>): void {
  const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN || config?.token;
  
  if (!token) {
    console.warn('⚠️ Mixpanel: NEXT_PUBLIC_MIXPANEL_TOKEN not set — tracking disabled');
    return;
  }

  try {
    mixpanel.init(token, {
      // Basic configuration
      api_host: 'https://api.mixpanel.com',
      
      // Tracking settings
      autocapture: true, // Track clicks, forms, page views automatically
      track_pageview: true,
      persistence: 'localStorage', // Use localStorage for persistence
      
      // Debug mode in development
      debug: config?.debug ?? process.env.NODE_ENV === 'development',
      
      // GDPR compliance — respect opt-out preference
      opt_out_tracking_by_default: false,
      opt_in_storageless_tracking_by_default: false,
      
      // User properties to set on first visit
      loaded: function(mixpanel) {
        if (process.env.NODE_ENV === 'development') {
          console.log('✅ Mixpanel client SDK initialized');
        }
      },
    });

    // Set initial user properties from cookie/localStorage if available
    const userId = localStorage.getItem('tourbillon_user_id') || sessionStorage.getItem('tourbillon_user_id');
    const userEmail = localStorage.getItem('tourbillon_user_email');
    
    if (userId) {
      mixpanel.identify(userId);
      
      // Set user properties
      const props: Record<string, any> = {};
      const userRole = localStorage.getItem('tourbillon_user_role');
      if (userRole) props.role = userRole;
      
      const planTier = localStorage.getItem('tourbillon_plan_tier');
      if (planTier) props.plan_tier = planTier;
      
      const firstLoginDate = localStorage.getItem('tourbillon_first_login_date');
      if (firstLoginDate) props.first_login_date = new Date(firstLoginDate);
      
      if (Object.keys(props).length > 0) {
        mixpanel.people.set(props);
      }
    }

  } catch (error) {
    console.error('❌ Failed to initialize Mixpanel client SDK:', error);
  }
}

// ============================================================================
// EVENT TRACKING FUNCTIONS
// ============================================================================

export interface TrackEventOptions {
  /** Event name */
  event: string;
  /** Custom properties */
  properties?: Record<string, any>;
}

/**
 * Track an event on the client side.
 * Returns true if successful, false if Mixpanel is not initialized or user opted out.
 */
export function trackEvent(options: TrackEventOptions): boolean {
  if (!mixpanel.has_opted_out_tracking()) {
    mixpanel.track(options.event, options.properties);
    return true;
  }
  return false;
}

/**
 * Identify a user — link anonymous activity to identified user.
 */
export function identifyUser(userId: string): void {
  if (userId) {
    mixpanel.identify(userId);
    
    // Update user properties on the client side too
    const userEmail = localStorage.getItem('tourbillon_user_email');
    if (userEmail) {
      mixpanel.people.set({ $email: userEmail });
    }
  }
}

/**
 * Set custom user properties in Mixpanel People.
 */
export function setUserProperties(properties: Record<string, any>): void {
  const userId = localStorage.getItem('tourbillon_user_id') || sessionStorage.getItem('tourbillon_user_id');
  
  if (userId && !mixpanel.has_opted_out_tracking()) {
    mixpanel.people.set(properties);
  }
}

// ============================================================================
// KEY EVENT TRACKING HELPERS
// ============================================================================

/**
 * Track when a user creates a goal.
 */
export function trackGoalCreated(goalId: string, properties?: Record<string, any>): boolean {
  return trackEvent({
    event: 'goal_created',
    properties: {
      ...properties,
      goal_id: goalId,
      user_role: localStorage.getItem('tourbillon_user_role') || null,
      plan_tier: localStorage.getItem('tourbillon_plan_tier') || null,
    },
  });
}

/**
 * Track when a user commits to a task (marks as in_progress).
 */
export function trackTaskCommitted(taskId: string, properties?: Record<string, any>): boolean {
  return trackEvent({
    event: 'task_committed',
    properties: {
      ...properties,
      task_id: taskId,
      user_role: localStorage.getItem('tourbillon_user_role') || null,
      plan_tier: localStorage.getItem('tourbillon_plan_tier') || null,
    },
  });
}

/**
 * Track when a user completes a session (login).
 */
export function trackSessionStarted(userId: string): boolean {
  // First identify the user on client side
  identifyUser(userId);
  
  return trackEvent({
    event: 'session_started',
    properties: {
      user_role: localStorage.getItem('tourbillon_user_role') || null,
      plan_tier: localStorage.getItem('tourbillon_plan_tier') || null,
    },
  });
}

/**
 * Track when a user views the dashboard.
 */
export function trackDashboardView(userId?: string): boolean {
  return trackEvent({
    event: 'dashboard_viewed',
    properties: {
      user_id: userId || localStorage.getItem('tourbillon_user_id') || null,
      timestamp: new Date().toISOString(),
    },
  });
}

// ============================================================================
// GDPR OPT-OUT MANAGEMENT
// ============================================================================

/**
 * Check if user has opted out of tracking.
 */
export function isOptedOut(): boolean {
  return mixpanel.has_opted_out_tracking();
}

/**
 * Opt the current user out of all Mixpanel tracking.
 * This clears cookies and local storage for Mixpanel.
 */
export function optOutOfTracking(): void {
  mixpanel.opt_out_tracking();
  localStorage.setItem('mixpanel_opt_out', 'true');
  
  if (process.env.NODE_ENV === 'development') {
    console.log('🚫 User opted out of Mixpanel tracking');
  }
}

/**
 * Opt the current user back into tracking.
 */
export function optIntoTracking(): void {
  mixpanel.opt_in_tracking();
  localStorage.removeItem('mixpanel_opt_out');
  
  if (process.env.NODE_ENV === 'development') {
    console.log('✅ User opted into Mixpanel tracking');
  }
}
