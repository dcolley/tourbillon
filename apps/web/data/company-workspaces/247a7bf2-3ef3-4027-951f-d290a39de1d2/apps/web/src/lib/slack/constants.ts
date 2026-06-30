// ============================================================================
// TOUR-97: Slack Integration — Constants & Types
// ============================================================================

// Priority color mapping for Slack block kit attachments
export const PRIORITY_COLORS: Record<string, string> = {
  critical: '#FF0000',
  high: '#FF4500',
  medium: '#FFA500',
  low: '#32CD32',
  normal: '#32CD32',
};

// Default channel for Slack notifications (overridable per workspace)
export const DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || '#general';

// Routing rules for feedback categorization
export interface RoutingRule {
  keywords: string[];
  channels: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export const FEEDBACK_ROUTING_RULES: RoutingRule[] = [
  {
    keywords: ['bug', 'error', 'crash', 'broken', 'not working', 'failed', 'exception'],
    channels: ['#critical-issues', '#product-feedback'],
    priority: 'high',
  },
  {
    keywords: ['feature request', 'suggestion', 'would be nice', 'could add', 'wish'],
    channels: ['#product-feedback'],
    priority: 'medium',
  },
  {
    keywords: ['pricing', 'billing', 'cost', 'subscription', 'cancel', 'refund'],
    channels: ['#customer-support'],
    priority: 'high',
  },
  {
    keywords: ['complaint', 'frustrated', 'disappointed', 'terrible', 'awful', 'worst'],
    channels: ['#customer-support', '#product-feedback'],
    priority: 'critical',
  },
];

// Fallback channel for uncategorized feedback
export const FALLBACK_CHANNEL = '#general-feedback';

// Slack App OAuth scopes needed for full functionality
export const SLACK_OAUTH_SCOPES = [
  'channels:read',       // Read channel info
  'chat:write',          // Post messages
  'chat:write.customize', // Custom bot username/emoji
  'commands',            // Use slash commands
  'im:history',          // Read direct message history
  'im:read',             // Read direct messages
  'users:read',          // Read user info
  'webhook:manage.bot',  // Manage incoming webhooks
];

// Slack App Manifest for easy installation
export const SLACK_APP_MANIFEST = {
  display_information: {
    name: 'Tourbillon Bot',
    description: 'Automated notifications and feedback routing for Tourbillon.',
    background_color: '#1e293b',
  },
  features: {
    bot_user: {
      display_name: 'Tourbillon Bot',
      always_online: true,
    },
    slash_commands: [
      {
        command: '/tourbillon-feedback',
        description: 'Submit feedback to Tourbillon channels',
        should_escape: false,
      },
    ],
  },
  oauth_configurations: {
    scopes: {
      bot: SLACK_OAUTH_SCOPES,
    },
  },
};

// Webhook verification constants
export const SLACK_SIGNATURE_HEADER = 'X-Slack-Signature';
export const SLACK_TIMESTAMP_HEADER = 'X-Slack-Request-Timestamp';
export const SIGNATURE_VERSION = 'v0';
export const MAX_TIMESTAMP_DRIFT_SECONDS = 60 * 5; // 5 minutes
