/**
 * Tourbillon Mixpanel Module — TOUR-147
 * 
 * Public API for the Mixpanel instrumentation layer.
 * Provides server-side tracking, client-side SDK, React hooks, and event types.
 */

// Server-side SDK (for API routes and SSR)
export {
  getServerMixpanel,
  trackEvent,
  identifyUser,
  setUserProperties,
  trackSignup,
  trackLogin,
  trackSessionStart,
  toggleOptOut,
  isOptedOut,
} from './server';

// Client-side SDK (for browser)
export {
  initMixpanel,
  trackEvent as clientTrackEvent,
  identifyUser as clientIdentifyUser,
  setUserProperties as clientSetUserProperties,
  trackGoalCreated,
  trackTaskCommitted,
  trackSessionStarted,
  trackDashboardView,
  isOptedOut as clientIsOptedOut,
  optOutOfTracking,
  optIntoTracking,
} from './client';

// React hook for component-level tracking
export { useMixpanel } from './hook';

// Event types and constants
export {
  MIXPANEL_EVENTS,
  type MixpanelEventName,
  type UserProperties,
  type GoalCreatedProperties,
  type TaskCommittedProperties,
  type SessionStartedProperties,
  type DashboardViewedProperties,
  type TrackOptions,
} from './types';
