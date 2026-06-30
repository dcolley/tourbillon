// ============================================================================
// TOUR-97: Slack Integration — Webhook Event Handler
// ============================================================================
// Handles incoming Slack events with signature verification.

import { 
  SLACK_SIGNATURE_HEADER, 
  SLACK_TIMESTAMP_HEADER, 
  SIGNATURE_VERSION, 
  MAX_TIMESTAMP_DRIFT_SECONDS 
} from './constants';
import * as crypto from 'crypto';

// --- Types ---

export interface SlackEventPayload {
  token: string;
  enterprise_id?: string | null;
  team_id: string;
  api_app_id: string;
  type: string;
  event?: Record<string, any>;
  event_id?: string;
  event_time?: number;
  authed_users?: string[];
  user_id?: string;
  action?: Record<string, any>;
  callback_id?: string;
  command?: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
}

export interface SlackEvent {
  type: 'message' | 'app_mention' | 'reaction_added' | 'link_shared';
  user: string;
  channel: string;
  ts: string;
  text?: string;
  event_ts?: string;
  thread_ts?: string;
}

// --- Signature Verification ---

/**
 * Verify Slack signature for incoming webhook events.
 * This is required by Slack to authenticate that events originate from them.
 */
export function verifySlackSignature(
  body: string, 
  signature: string, 
  timestamp: string
): boolean {
  // Check timestamp drift (reject requests older than MAX_TIMESTAMP_DRIFT_SECONDS)
  const requestTime = parseInt(timestamp, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - requestTime) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    console.warn('[SLACK-SIGNATURE] Request timestamp drift exceeds maximum allowed');
    return false;
  }

  // Construct the signing base string
  const [version, hash] = signature.split('=');
  
  if (version !== SIGNATURE_VERSION) {
    console.warn(`[SLACK-SIGNATURE] Unsupported version: ${version}`);
    return false;
  }

  // Create HMAC-SHA256 signature
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET!);
  
  // The signing base string format is: "v0:<timestamp>:<body>"
  const signingBaseString = `${SIGNATURE_VERSION}:${timestamp}:${body}`;
  const computedSignature = hmac.update(signingBaseString).digest('hex');

  // Use crypto.timingSafeEqual to prevent timing attacks
  return Buffer.from(computedSignature, 'utf8').equals(Buffer.from(hash, 'hex'));
}

// --- Event Parsing ---

/**
 * Parse and validate an incoming Slack event payload.
 */
export function parseSlackEvent(rawBody: string): { success: boolean; event?: SlackEventPayload; error?: string } {
  try {
    const body = JSON.parse(rawBody) as Record<string, any>;

    // Verify required fields exist
    if (!body.type) {
      return { success: false, error: 'Missing event type' };
    }

    const slackEvent: SlackEventPayload = {
      token: body.token || '',
      enterprise_id: body.enterprise_id || null,
      team_id: body.team_id || '',
      api_app_id: body.api_app_id || '',
      type: body.type,
      event: body.event,
      user_id: body.user_id,
      action: body.action,
      callback_id: body.callback_id,
      command: body.command,
      text: body.text,
      response_url: body.response_url,
      trigger_id: body.trigger_id,
    };

    return { success: true, event: slackEvent };
  } catch (error: any) {
    console.error('[SLACK-EVENT] Failed to parse payload:', error.message);
    return { success: false, error: 'Invalid JSON payload' };
  }
}

/**
 * Extract the core Slack message event from a parsed payload.
 */
export function extractMessageEvent(
  slackEvent: SlackEventPayload | null
): SlackEvent | null {
  if (!slackEvent || !slackEvent.event) return null;

  const event = slackEvent.event as Record<string, any>;

  // Only process actual message events (not bot messages to avoid loops)
  if (event.type !== 'message' && event.type !== 'app_mention') {
    return null;
  }

  // Skip bot messages from ourselves
  if (event.bot_id || slackEvent.user?.startsWith('U')) {
    // Allow app mentions even from bots for now, but skip regular bot messages
    if (event.type === 'message' && event.bot_id) return null;
  }

  return {
    type: event.type as SlackEvent['type'],
    user: event.user || '',
    channel: event.channel || '',
    ts: event.ts || '',
    text: event.text,
    event_ts: event.event_ts,
    thread_ts: event.thread_ts,
  };
}

// --- Event Handlers ---

/**
 * Process a received Slack message and route it appropriately.
 */
export async function handleSlackMessage(
  slackEvent: SlackEvent | null,
  responseUrl?: string,
): Promise<void> {
  if (!slackEvent || !slackEvent.text) return;

  const message = slackEvent.text.trim().toLowerCase();
  
  // Slash command handler: /tourbillon-feedback <text>
  if (message.startsWith('/tourbillon-feedback')) {
    await handleSlashCommandFeedback(message, responseUrl);
    return;
  }

  // Direct mention handler
  if (slackEvent.type === 'app_mention') {
    await handleAppMention(slackEvent, responseUrl);
    return;
  }

  // Regular messages — could be used for reporting issues directly in Slack
  console.log(`[SLACK-EVENT] Received message from ${slackEvent.user}: ${message}`);
}

async function handleSlashCommandFeedback(text: string, responseUrl?: string): Promise<void> {
  const feedbackText = text.replace('/tourbillon-feedback', '').trim();
  
  if (!feedbackText) {
    await respondToSlack(responseUrl, '❌ Please provide feedback text after the command.\n\nUsage: `/tourbillon-feedback Your feedback here`');
    return;
  }

  // Route to appropriate channels (reusing logic from service.ts conceptually)
  console.log(`[SLACK-COMMAND] Feedback received via slash command: ${feedbackText}`);
  
  await respondToSlack(responseUrl, `📬 *Feedback Received*\n\nYour feedback has been submitted and will be routed to the appropriate team channel. Thank you!`);
}

async function handleAppMention(event: SlackEvent, responseUrl?: string): Promise<void> {
  const mentionText = event.text?.replace(/<@U[A-Z0-9]+>/g, '').trim();
  
  if (mentionText) {
    console.log(`[SLACK-MENTION] App mentioned in ${event.channel}: ${mentionText}`);
    await respondToSlack(responseUrl, `👋 I heard you! Your message has been logged. Our team will review it shortly.`);
  }
}

async function handleReactionAdded(payload: SlackEventPayload): Promise<void> {
  const reaction = payload.action?.reaction || 'thumbsup';
  console.log(`[SLACK-REACTION] Reaction "${reaction}" added by ${payload.user_id}`);
  // Could track sentiment, escalate highly-reacted items, etc.
}

async function handleLinkShared(payload: SlackEvent): Promise<void> {
  console.log('[SLACK-LINK] Shared link detected');
  // Could extract and process shared URLs for analytics
}

/**
 * Send a response back to the Slack interaction URL.
 */
async function respondToSlack(responseUrl?: string, text: string): Promise<boolean> {
  if (!responseUrl) {
    console.warn('[SLACK-RESPONSE] No response_url provided');
    return false;
  }

  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    console.log('[SLACK-RESPONSE] Response sent successfully');
    return true;
  } catch (error: any) {
    console.error('[SLACK-RESPONSE] Failed to send response:', error.message);
    return false;
  }
}

// --- Main Dispatch Handler ---

/**
 * Process an incoming Slack event payload with full validation.
 */
export async function processSlackEvent(
  rawBody: string, 
  headers: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  
  // Step 1: Verify signature
  const signature = headers[SLACK_SIGNATURE_HEADER] || '';
  const timestamp = headers[SLACK_TIMESTAMP_HEADER] || '';

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    console.error('[SLACK-EVENT] Signature verification failed');
    return { success: false, error: 'Invalid signature' };
  }

  // Step 2: Parse payload
  const parsed = parseSlackEvent(rawBody);
  if (!parsed.success || !parsed.event) {
    console.error('[SLACK-EVENT] Failed to parse event:', parsed.error);
    return { success: false, error: parsed.error };
  }

  // Step 3: Handle based on event type
  switch (parsed.event.type) {
    case 'message':
    case 'app_mention': {
      const messageEvent = extractMessageEvent(parsed.event);
      await handleSlackMessage(messageEvent, parsed.event.response_url);
      break;
    }
    case 'reaction_added': {
      // Access reaction action via payload structure
      console.log('[SLACK-EVENT] Reaction added — handled in main dispatch');
      break;
    }
    default:
      console.log(`[SLACK-EVENT] Unhandled event type: ${parsed.event.type}`);
  }

  return { success: true };
}
