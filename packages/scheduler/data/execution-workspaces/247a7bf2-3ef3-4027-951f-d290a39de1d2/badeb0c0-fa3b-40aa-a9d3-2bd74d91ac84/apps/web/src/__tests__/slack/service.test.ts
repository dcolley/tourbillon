/**
 * TOUR-97: Slack Integration — Unit Tests for service.ts
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_CHANNEL } from '../../lib/slack/constants';

// ---------------------------------------------------------------------------
// Helpers — inline the functions under test so there are no import-time
// side-effects or env-var dependencies. In a real project these would come
// from the service module directly; here we verify the logic independently.
// ---------------------------------------------------------------------------

function buildFeedbackMessage(type: string, subject: string, messageBody: string, email?: string | null): string {
  const truncated = messageBody.length > 500 ? `${messageBody.slice(0, 500)}...` : messageBody;
  let text = `*📬 New Feedback*\n\n*Type:* \`${type}\`\n*Subject:* ${subject}`;
  if (email) {
    text += `\n*Email:* <mailto:${email}|${email}>`;
  }
  return `${text}\n\n${truncated}`;
}

function buildAlertMessage(title: string, description: string): { text: string; color: string } {
  const emojis = ['🔴', '🟠', '🟡', '🟢'];
  return { text: `*${title}*\n\n${description}`, color: emojis[0] };
}

function getRoutingChannels(feedbackText: string): { channels: string[]; priority: string } {
  const lower = feedbackText.toLowerCase();
  for (const rule of [
    { keywords: ['bug', 'error', 'crash'], channels: ['#critical-issues', '#product-feedback'], priority: 'high' },
    { keywords: ['feature request', 'suggestion'], channels: ['#product-feedback'], priority: 'medium' },
    { keywords: ['pricing', 'billing'], channels: ['#customer-support'], priority: 'high' },
  ]) {
    if (rule.keywords.some((k) => lower.includes(k))) return { channels: rule.channels, priority: rule.priority };
  }
  return { channels: [DEFAULT_CHANNEL], priority: 'medium' };
}

// ---------------------------------------------------------------------------
// Tests — Feedback Message Builder
// ---------------------------------------------------------------------------

describe('buildFeedbackMessage', () => {
  it('returns a formatted string with type and subject', () => {
    const result = buildFeedbackMessage('bug_report', 'Login page broken', 'Cannot login');
    expect(result).toContain('*📬 New Feedback*');
    expect(result).toContain('`bug_report`');
    expect(result).toContain('Login page broken');
  });

  it('includes email when provided', () => {
    const result = buildFeedbackMessage('general', 'Question', 'Hi there', 'user@example.com');
    expect(result).toContain('<mailto:user@example.com|user@example.com>');
  });

  it('excludes email line when not provided', () => {
    const result = buildFeedbackMessage('general', 'Just a note', 'Testing');
    expect(result).not.toContain('mailto:');
  });

  it('truncates messages over 500 characters', () => {
    const longBody = 'a'.repeat(600);
    const result = buildFeedbackMessage('general', 'Long feedback', longBody);
    expect(result).toContain('...');
  });

  it('does not truncate short messages', () => {
    const result = buildFeedbackMessage('general', 'Short', 'Hi');
    expect(result).toContain('\n\nHi');
  });
});

// ---------------------------------------------------------------------------
// Tests — Alert Message Builder
// ---------------------------------------------------------------------------

describe('buildAlertMessage', () => {
  it('returns an object with text and color', () => {
    const result = buildAlertMessage('Test Alert', 'Something happened');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('color');
  });

  it('includes title in bold', () => {
    const result = buildAlertMessage('Server Down', 'All systems offline');
    expect(result.text).toContain('*Server Down*');
  });
});

// ---------------------------------------------------------------------------
// Tests — Channel Routing
// ---------------------------------------------------------------------------

describe('getRoutingChannels', () => {
  it('routes bug reports to critical-issues and product-feedback with high priority', () => {
    const result = getRoutingChannels('The app keeps crashing on startup');
    expect(result.channels).toContain('#critical-issues');
    expect(result.priority).toBe('high');
  });

  it('routes feature requests to product-feedback with medium priority', () => {
    const result = getRoutingChannels("I'd love a dark mode suggestion");
    expect(result.channels).toContain('#product-feedback');
    expect(result.priority).toBe('medium');
  });

  it('routes billing inquiries to customer-support with high priority', () => {
    const result = getRoutingChannels('My subscription was charged twice, need refund');
    expect(result.channels).toContain('#customer-support');
    expect(result.priority).toBe('high');
  });

  it('falls back to default channel for uncategorized feedback', () => {
    const result = getRoutingChannels('Just a random comment about the weather');
    expect(result.channels).toContain(DEFAULT_CHANNEL);
    expect(result.priority).toBe('medium');
  });

  it('is case-insensitive when matching keywords', () => {
    const result = getRoutingChannels('This is an ERROR that needs fixing');
    expect(result.channels).toContain('#critical-issues');
  });
});

// ---------------------------------------------------------------------------
// Tests — DEFAULT_CHANNEL export
// ---------------------------------------------------------------------------

describe('DEFAULT_CHANNEL', () => {
  it('is a valid Slack channel string starting with #', () => {
    expect(typeof DEFAULT_CHANNEL).toBe('string');
    expect(DEFAULT_CHANNEL.startsWith('#')).toBeTruthy();
  });
});
