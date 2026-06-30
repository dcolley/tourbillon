/**
 * Tourbillon Mixpanel Event Types — TOUR-147
 * 
 * Type-safe event definitions for Mixpanel tracking.
 */

// ============================================================================
// EVENT NAMES
// ============================================================================

export const MIXPANEL_EVENTS = {
  // User lifecycle events (required by task)
  USER_SIGNED_UP: 'User Signed Up',
  USER_LOGGED_IN: 'User Logged In',
  SESSION_STARTED: 'session_started',
  
  // Goal & Task events (required by task)
  GOAL_CREATED: 'goal_created',
  TASK_COMMITTED: 'task_committed',
  
  // Page view events
  DASHBOARD_VIEWED: 'dashboard_viewed',
  GOALS_LIST_VIEWED: 'goals_list_viewed',
  TASKS_LIST_VIEWED: 'tasks_list_viewed',
  SETTINGS_VIEWED: 'settings_viewed',
  
  // Feature usage events
  SLACK_CONNECTED: 'slack_connected',
  GITHUB_CONNECTED: 'github_connected',
  GOOGLE_CONNECTED: 'google_connected',
  
  // Feedback & NPS events
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  NPS_RESPONSE: 'nps_response',
} as const;

export type MixpanelEventName = typeof MIXPANEL_EVENTS[keyof typeof MIXPANEL_EVENTS];

// ============================================================================
// USER PROPERTIES (required by task)
// ============================================================================

export interface UserProperties {
  /** User's email address */
  $email?: string | null;
  /** User's display name */
  $name?: string | null;
  /** User's role in the system: admin, member, viewer */
  user_role?: 'admin' | 'member' | 'viewer' | null;
  /** User's plan tier: free, pro, enterprise */
  plan_tier?: 'free' | 'pro' | 'enterprise' | null;
  /** Date when user first logged in (ISO string) */
  first_login_date?: string | Date | null;
  /** Account creation date */
  created_at?: string | Date | null;
}

// ============================================================================
// EVENT PROPERTIES
// ============================================================================

export interface GoalCreatedProperties extends Record<string, any> {
  goal_id: string;
  user_role?: 'admin' | 'member' | 'viewer' | null;
  plan_tier?: 'free' | 'pro' | 'enterprise' | null;
}

export interface TaskCommittedProperties extends Record<string, any> {
  task_id: string;
  goal_id?: string;
  user_role?: 'admin' | 'member' | 'viewer' | null;
  plan_tier?: 'free' | 'pro' | 'enterprise' | null;
}

export interface SessionStartedProperties extends Record<string, any> {
  user_role?: 'admin' | 'member' | 'viewer' | null;
  plan_tier?: 'free' | 'pro' | 'enterprise' | null;
  login_method?: 'email' | 'google' | 'github' | 'auth0';
}

export interface DashboardViewedProperties extends Record<string, any> {
  user_id?: string | null;
  timestamp: string;
}

// ============================================================================
// TRACKING OPTIONS
// ============================================================================

export interface TrackOptions {
  /** Enable or disable tracking (for GDPR compliance) */
  enabled?: boolean;
  /** User's distinct ID for cross-device tracking */
  distinct_id?: string;
}
