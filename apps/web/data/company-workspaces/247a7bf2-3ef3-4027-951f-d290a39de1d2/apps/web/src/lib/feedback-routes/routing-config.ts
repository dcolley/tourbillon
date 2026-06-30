// TOUR-62: Feedback Routing Configuration
// Central configuration for all feedback routing rules

export const SLACK_CHANNELS = {
  CRITICAL_ISSUES: '#critical-issues',
  PRODUCT_FEEDBACK: '#product-feedback',
  CUSTOMER_SUPPORT: '#customer-support',
  GENERAL_FEEDBACK: '#general-feedback',
} as const;

export interface RoutingRule {
  keywords: string[];
  channels: (typeof SLACK_CHANNELS)[keyof typeof SLACK_CHANNELS][];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export const routingRules: RoutingRule[] = [
  {
    keywords: ['bug', 'error', 'crash', 'broken', 'not working', 'failed', 'exception'],
    channels: [SLACK_CHANNELS.CRITICAL_ISSUES, SLACK_CHANNELS.PRODUCT_FEEDBACK],
    priority: 'high',
  },
  {
    keywords: ['feature request', 'suggestion', 'would be nice', 'could add', 'wish'],
    channels: [SLACK_CHANNELS.PRODUCT_FEEDBACK],
    priority: 'medium',
  },
  {
    keywords: ['pricing', 'billing', 'cost', 'subscription', 'cancel', 'refund'],
    channels: [SLACK_CHANNELS.CUSTOMER_SUPPORT],
    priority: 'high',
  },
  {
    keywords: ['complaint', 'frustrated', 'disappointed', 'terrible', 'awful', 'worst'],
    channels: [SLACK_CHANNELS.CUSTOMER_SUPPORT, SLACK_CHANNELS.PRODUCT_FEEDBACK],
    priority: 'critical',
  },
];

export const FALLBACK_CHANNEL = SLACK_CHANNELS.GENERAL_FEEDBACK;

export function matchRoutingRule(text: string): RoutingRule {
  const lowerText = text.toLowerCase();
  
  for (const rule of routingRules) {
    if (rule.keywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      return rule;
    }
  }
  
  return { keywords: [], channels: [FALLBACK_CHANNEL], priority: 'medium' };
}

export function getSlackColor(priority: string): string {
  const colors = {
    critical: '#FF0000',
    high: '#FF4500',
    medium: '#FFA500',
    low: '#32CD32',
  };
  
  return colors[priority as keyof typeof colors] || '#32CD32';
}
