/**
 * Tourbillon Mixpanel React Hook — TOUR-147
 * 
 * Custom hook for client-side Mixpanel event tracking in React components.
 */

import { useCallback, useEffect, useRef } from 'react';
import { getInitialMixpanelEvents, isOptedOut, trackEvent as browserTrackEvent, identifyUser, setUserProperties } from './client';

// ============================================================================
// MIXPANEL TRACKING HOOK
// ============================================================================

export function useMixpanel() {
  const initialized = useRef(false);

  // Initialize Mixpanel on mount (only once)
  useEffect(() => {
    if (!initialized.current) {
      try {
        // Dynamic import to avoid SSR issues
        import('./client').then(({ initMixpanel }) => {
          initMixpanel();
          initialized.current = true;
        });
      } catch (error) {
        console.warn('⚠️ Failed to initialize Mixpanel:', error);
      }
    }
  }, []);

  /**
   * Track an event with optional properties.
   */
  const track = useCallback((event: string, properties?: Record<string, any>) => {
    return browserTrackEvent({ event, properties });
  }, []);

  /**
   * Identify a user by their unique ID.
   */
  const identify = useCallback((userId: string) => {
    identifyUser(userId);
  }, []);

  /**
   * Set custom user properties.
   */
  const setProperties = useCallback((properties: Record<string, any>) => {
    setUserProperties(properties);
  }, []);

  /**
   * Check if tracking is enabled (user hasn't opted out).
   */
  const isEnabled = useCallback(() => !isOptedOut(), []);

  /**
   * Opt user out of all Mixpanel tracking.
   */
  const optOutOfTracking = useCallback(() => {
    import('./client').then(({ optOutOfTracking }) => {
      optOutOfTracking();
    });
  }, []);

  /**
   * Opt user back into Mixpanel tracking.
   */
  const optIntoTracking = useCallback(() => {
    import('./client').then(({ optIntoTracking: optIn }) => {
      optIn();
    });
  }, []);

  return {
    track,
    identify,
    setProperties,
    isEnabled,
    optOutOfTracking,
    optIntoTracking,
  };
}

// ============================================================================
// USAGE EXAMPLES
// ============================================================================

/**
 * Example: Track events in a React component
 */
/*
import { useMixpanel } from '@/lib/mixpanel/hook';

function MyComponent() {
  const { track, identify } = useMixpanel();

  const handleGoalCreated = (goalId) => {
    track('goal_created', { goal_id: goalId });
  };

  useEffect(() => {
    // Identify user when they log in
    if (user) {
      identify(user.id);
    }
  }, [user]);

  return <button onClick={handleGoalCreated}>Create Goal</button>;
}
*/

/**
 * Example: Track page views with useMixpanel and useEffect
 */
/*
import { usePathname } from 'next/navigation';

function PageTracker() {
  const { track } = useMixpanel();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname) {
      track('page_view', { page: pathname });
    }
  }, [pathname, track]);

  return null; // This component doesn't render anything
}
*/
