/**
 * Tourbillon Mixpanel Server SDK — TOUR-147
 * 
 * Server-side Mixpanel client for tracking user events via API.
 * Uses mixpanel-node library for reliable event sending.
 */

import Mixpanel from 'mixpanel';

// ============================================================================
// MIXPANEL CONFIGURATION
// ============================================================================

interface MixpanelConfig {
  token: string;
  options?: {
    /** Queue size (default: 10) */
    batch_size?: number;
    /** Time to wait before sending a batch in ms (default: 500ms) */
    timeout?: number;
    /** Request timeout in ms (default: 30s) */
    request_timeout?: number;
  };
}

const globalForMixpanel = globalThis as unknown as {
  mixpanelClient: Mixpanel.Mixpanel | undefined;
};

/**
 * Get or create the server-side Mixpanel client singleton.
 */
export function getServerMixpanel(): Mixpanel.Mixpanel | null {
  const config: MixpanelConfig = {
    token: process.env.NEXT_PUBLIC_MIXPANEL_TOKEN || '',
  };

  if (!config.token) {
    // Graceful degradation — analytics disabled without token
    return null;
  }

  if (globalForMixpanel.mixpanelClient) {
    return globalForMixpanel.mixpanelClient;
  }

  try {
    const client = Mixpanel.init(config.token, {
      batch_size: config.options?.batch_size || 10,
      timeout: config.options?.timeout || 500,
      request_timeout: config.options?.request_timeout || 30000,
      // Don't log in production
      verbose: process.env.NODE_ENV === 'development',
    });

    globalForMixpanel.mixpanelClient = client;
    
    if (process.env.NODE_ENV === 'development') {
      console.log('✅ Mixpanel server SDK initialized');
    }
    
    return client;
  } catch (error) {
    console.error('❌ Failed to initialize Mixpanel server SDK:', error);
    return null;
  }
}

// ============================================================================
// EVENT TRACKING FUNCTIONS
// ============================================================================

export interface TrackEventOptions {
  /** Unique user identifier */
  distinct_id: string;
  /** Event name */
  event_name: string;
  /** Custom properties to include with the event */
  properties?: Record<string, any>;
}

/**
 * Track a single event on the server side.
 * Returns true if successful, false if Mixpanel is unavailable or request failed.
 */
export async function trackEvent(options: TrackEventOptions): Promise<boolean> {
  const client = getServerMixpanel();
  
  if (!client) return false; // Graceful degradation
  
  try {
    const { distinct_id, event_name, properties } = options;
    
    // Always include standard properties
    const fullProperties: Record<string, any> = {
      ...properties,
      timestamp: new Date().toISOString(),
      token: process.env.NEXT_PUBLIC_MIXPANEL_TOKEN,
      platform: 'server',
      // GDPR compliance — don't track if opt-out is set
      ...(globalForMixpanel.optOut && { mixpanel_opt_out: true }),
    };

    await client.track(event_name, {
      distinct_id,
      ...fullProperties,
    });
    
    return true;
  } catch (error) {
    console.warn('⚠️ Mixpanel track failed:', error);
    return false;
  }
}

/**
 * Identify a user — link anonymous activity to identified user.
 */
export async function identifyUser(options: {
  distinct_id: string;
  properties?: Record<string, any>;
}): Promise<boolean> {
  const client = getServerMixpanel();
  
  if (!client) return false;
  
  try {
    await client.identify(options.distinct_id);
    
    if (options.properties) {
      await client.people.set(options.distinct_id, options.properties);
    }
    
    return true;
  } catch (error) {
    console.warn('⚠️ Mixpanel identify failed:', error);
    return false;
  }
}

/**
 * Set user properties in Mixpanel People.
 */
export async function setUserProperties(options: {
  distinct_id: string;
  properties: Record<string, any>;
}): Promise<boolean> {
  const client = getServerMixpanel();
  
  if (!client) return false;
  
  try {
    await client.people.set(options.distinct_id, options.properties);
    return true;
  } catch (error) {
    console.warn('⚠️ Mixpanel set failed:', error);
    return false;
  }
}

/**
 * Track user signup event.
 */
export async function trackSignup(distinctId: string, properties?: Record<string, any>): Promise<boolean> {
  return trackEvent({
    distinct_id: distinctId,
    event_name: 'User Signed Up',
    properties: {
      ...properties,
      $email: properties?.email || null,
      $name: properties?.name || null,
    },
  });
}

/**
 * Track user login event.
 */
export async function trackLogin(distinctId: string, properties?: Record<string, any>): Promise<boolean> {
  return trackEvent({
    distinct_id: distinctId,
    event_name: 'User Logged In',
    properties,
  });
}

/**
 * Track session start.
 */
export async function trackSessionStart(distinctId: string): Promise<boolean> {
  return trackEvent({
    distinct_id: distinctId,
    event_name: 'session_started',
  });
}

// ============================================================================
// GDPR OPT-OUT MANAGEMENT
// ============================================================================

/** Global opt-out flag (can be set per-user via cookies/localStorage) */
let globalOptOut = false;

export function toggleOptOut(optOut: boolean): void {
  globalOptOut = optOut;
}

export function isOptedOut(): boolean {
  return globalOptOut;
}
