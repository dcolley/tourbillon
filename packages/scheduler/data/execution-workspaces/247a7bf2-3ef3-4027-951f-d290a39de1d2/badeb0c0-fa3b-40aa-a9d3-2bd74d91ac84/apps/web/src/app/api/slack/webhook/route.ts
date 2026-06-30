// ============================================================================
// TOUR-97: Slack Integration — Webhook Event Receiver
// ============================================================================
// Receives and processes incoming Slack events with signature verification.

import { NextResponse } from 'next/server';
import { processSlackEvent, verifySlackSignature } from '@/lib/slack/webhook-handler';
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } from '@/lib/slack/constants';

/**
 * POST /api/slack/webhook — Receive Slack events.
 * 
 * This endpoint receives all event types from the Slack API:
 * - message events (when users type in channels)
 * - app_mention events (when bot is mentioned with @TourbillonBot)
 * - reaction_added events (when reactions are added to messages)
 * - link_shared events (when links are shared)
 * 
 * All requests must include X-Slack-Signature and X-Slack-Request-Timestamp headers.
 */
export async function POST(request: Request) {
  try {
    // Parse request body for signature verification
    const rawBody = await request.text();

    if (!rawBody) {
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }

    // Extract headers for signature verification
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Verify Slack's HMAC-SHA256 signature to ensure events are from Slack
    const signature = headers[SLACK_SIGNATURE_HEADER] || '';
    const timestamp = headers[SLACK_TIMESTAMP_HEADER] || '';

    if (!signature || !timestamp) {
      console.warn('[SLACK-WEBHOOK] Missing security headers');
      return NextResponse.json(
        { error: 'Missing required security headers' },
        { status: 401 }
      );
    }

    // Verify signature before processing (prevents replay attacks and spoofing)
    if (!verifySlackSignature(rawBody, signature, timestamp)) {
      console.error('[SLACK-WEBHOOK] Signature verification failed');
      return NextResponse.json(
        { error: 'Invalid request signature' },
        { status: 401 }
      );
    }

    // Process the verified event
    const result = await processSlackEvent(rawBody, headers);

    if (!result.success) {
      console.error('[SLACK-WEBHOOK] Event processing failed:', result.error);
      return NextResponse.json(
        { error: 'Failed to process event', details: result.error },
        { status: 400 }
      );
    }

    // Slack expects a 200 OK response quickly (within 3 seconds)
    // For async processing, events are handled in background
    return NextResponse.json({ ok: true });

  } catch (error: any) {
    console.error('[SLACK-WEBHOOK] Unhandled error:', error.message);
    
    // Always respond with 200 to Slack even on errors
    // This prevents Slack from retrying the event and flooding us
    return NextResponse.json({ ok: true });
  }
}

/**
 * GET /api/slack/webhook — Health check endpoint.
 */
export async function GET() {
  const hasSigningSecret = !!process.env.SLACK_SIGNING_SECRET;
  
  return NextResponse.json({
    status: 'active',
    slackIntegration: true,
    configured: hasSigningSecret,
    features: [
      'Incoming webhooks with signature verification',
      'Message event handling (text and mentions)',
      'Slash command processing (/tourbillon-feedback)',
      'Reaction tracking',
      'Link sharing detection',
    ],
  });
}

