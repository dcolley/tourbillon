// ============================================================================
// TOUR-97: Slack Integration Service — Centralized Module
// 
// Reusable Slack messaging utility used across all Tourbillon services.
// Provides standardized message formatting, color-coded priority alerts,
// and robust error handling with graceful degradation.
//
// Usage in any module:
//   import { sendToSlack } from '@tourbillon/slack/service';
// 
// Environment Variables:
//   SLACK_WEBHOOK_URL — Incoming webhook URL for posting messages
// ============================================================================

export type SlackPriority = 'critical' | 'high' | 'medium' | 'low';

export interface SendToSlackOptions {
  message: string;
  priority?: SlackPriority;
  channel?: string;
}

export interface FeedbackRouteInfo {
  channels: string[];
  priority: SlackPriority;
}

// --- Color Mapping ---

const COLOR_MAP: Record<SlackPriority, string> = {
  critical: '#FF0000', // Red — immediate attention required
  high: '#FF4500',     // Orange-Red — urgent but not critical
  medium: '#FFA500',   // Orange — moderate priority
  low: '#32CD32',      // Green-Lime — informational
};

// --- Routing Rules (keyword-based) ---

const ROUTING_RULES = [
  {
    keywords: ['bug', 'error', 'crash', 'broken', 'not working', 'failed', 'exception'],
    channels: ['#critical-issues', '#product-feedback'] as const,
    priority: 'high' as SlackPriority,
  },
  {
    keywords: ['feature request', 'suggestion', 'would be nice', 'could add', 'wish'],
    channels: ['#product-feedback'] as const,
    priority: 'medium' as SlackPriority,
  },
  {
    keywords: ['pricing', 'billing', 'cost', 'subscription', 'cancel', 'refund'],
    channels: ['#customer-support'] as const,
    priority: 'high' as SlackPriority,
  },
  {
    keywords: ['complaint', 'frustrated', 'disappointed', 'terrible', 'awful', 'worst'],
    channels: ['#customer-support', '#product-feedback'] as const,
    priority: 'critical' as SlackPriority,
  },
];

const FALLBACK_CHANNEL = '#general-feedback';
const FALLBACK_PRIORITY: SlackPriority = 'medium';

// --- Core Functions ---

/**
 * Send a message to a Slack channel via Incoming Webhook.
 * Returns true on success, false on failure (with logging).
 */
export async function sendToSlack({
  message,
  priority = 'low',
  channel,
}: SendToSlackOptions): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log(`[SLACK] Webhook URL not configured — would post to ${channel || 'default'}:`, message);
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Tourbillon Bot',
        icon_emoji: ':feedback:',
        attachments: [
          {
            color: COLOR_MAP[priority],
            title: `${channel ? `📬 ${channel} — ` : ''}${getPriorityLabel(priority)}`,
            text: message,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`[SLACK] Failed to post message to ${channel || 'default'}:`, response.statusText);
      return false;
    }

    console.log(`[SLACK] Posted to ${channel || 'default'} successfully (priority: ${priority})`);
    return true;
  } catch (error) {
    console.error(`[SLACK] Error sending message:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Build a formatted Slack message for feedback submissions.
 */
export function buildFeedbackMessage(
  type: string,
  subject: string,
  message: string,
  email?: string,
): string {
  const truncated = message.length > 500 ? `${message.slice(0, 497)}...` : message;
  
  return `*Feedback Type:* ${type}\n*Subject:* ${subject}${email ? `\n*Email:* ${email}` : ''}\n*Message:* ${truncated}`;
}

/**
 * Build a formatted Slack message for NPS detractor alerts.
 */
export function buildNpsDetractorAlert(
  score: number,
  comment?: string | null,
  email?: string | null,
): string {
  return `*Score:* ${score}/10 (Detractor)\n${email ? `*Email:* ${email}\n` : ''}${comment ? `*Comment:* ${comment}` : '*No additional comments provided*'}`;
}

/**
 * Match feedback text against routing rules to determine target Slack channels.
 */
export function getRoutingChannels(feedbackText: string): FeedbackRouteInfo {
  const lowerText = feedbackText.toLowerCase();

  for (const rule of ROUTING_RULES) {
    if (rule.keywords.some(keyword => lowerText.includes(keyword))) {
      return {
        channels: [...rule.channels],
        priority: rule.priority,
      };
    }
  }

  return {
    channels: [FALLBACK_CHANNEL],
    priority: FALLBACK_PRIORITY,
  };
}

/**
 * Get a human-readable label for a Slack priority level.
 */
function getPriorityLabel(priority: SlackPriority): string {
  const labels = {
    critical: '🚨 CRITICAL',
    high: '⚠️ HIGH PRIORITY',
    medium: 'ℹ️ MEDIUM PRIORITY',
    low: '✅ LOW PRIORITY',
  };

  return labels[priority];
}
