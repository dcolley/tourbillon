// ============================================================================
// TOUR-100: Webhooks API Route — Incoming Event Handler
// 
// Accepts incoming webhook events from external services (Stripe, forms, etc.)
// Verifies signatures, processes events, and routes via Slack integration.
//
// POST /api/webhooks
//   Content-Type: application/json
//   x-webhook-signature: <hmac-sha256> (required for production)
//   
// Payload Examples:
//   { type: 'feedback.submitted', data: { ... } }
//   { type: 'nps.response', data: { score, comment, email } }
//   { type: 'payment.received', data: { amount, currency, user_id } }
// ============================================================================

import { NextResponse } from 'next/server';
import { handleVerification, registerEndpoint, dispatchEvent, getActiveEndpoints } from '@/lib/webhooks/service';
import { sendToSlack, buildFeedbackMessage, buildNpsDetractorAlert, getRoutingChannels } from '@/lib/slack/service';

// --- Environment Configuration ---

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // For signature verification in production
const ALLOWED_ORIGINS = ['https://webhook.site', 'http://localhost:3000']; // Development origins

// --- Incoming Webhook Handlers ---

interface FeedbackSubmittedEvent {
  type: 'feedback.submitted';
  data: {
    subject?: string;
    message: string;
    email?: string;
    source?: string;
  };
}

interface NpsResponseEvent {
  type: 'nps.response';
  data: {
    score: number;
    comment?: string | null;
    email?: string | null;
  };
}

interface PaymentReceivedEvent {
  type: 'payment.received';
  data: {
    amount: number;
    currency: string;
    userId: string;
    invoiceId: string;
  };
}

type IncomingWebhookEvent = FeedbackSubmittedEvent | NpsResponseEvent | PaymentReceivedEvent;

// --- Event Processing ---

async function processFeedbackEvent(event: FeedbackSubmittedEvent): Promise<void> {
  const { subject, message, email } = event.data;
  
  // Route to Slack based on keywords in the feedback
  const routing = getRoutingChannels(message);
  
  for (const channel of routing.channels) {
    await sendToSlack({
      message: buildFeedbackMessage(
        'feedback.submitted',
        subject || 'No Subject',
        message,
        email
      ),
      priority: routing.priority,
      channel,
    });
  }
  
  console.log(`[WEBHOOKS] Processed feedback event (priority: ${routing.priority})`);
}

async function processNpsEvent(event: NpsResponseEvent): Promise<void> {
  const { score, comment, email } = event.data;
  
  // Only alert for detractors (score <= 6)
  if (score <= 6) {
    await sendToSlack({
      message: buildNpsDetractorAlert(score, comment || undefined, email || undefined),
      priority: 'critical',
      channel: '#customer-support',
    });
    
    console.log(`[WEBHOOKS] NPS detractor alert sent (score: ${score})`);
  } else {
    console.log(`[WEBHOOKS] NPS response received but not a detractor (score: ${score})`);
  }
}

async function processPaymentEvent(event: PaymentReceivedEvent): Promise<void> {
  const { amount, currency, userId, invoiceId } = event.data;
  
  // Send payment notification to Slack
  await sendToSlack({
    message: `*Payment Received*\nAmount: ${amount} ${currency}\nUser ID: ${userId}\nInvoice: ${invoiceId}`,
    priority: 'high',
    channel: '#billing',
  });
  
  console.log(`[WEBHOOKS] Payment event processed (amount: ${amount} ${currency})`);
}

// --- Request Handler ---

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Parse the incoming payload
    const body = await request.text();
    let event: IncomingWebhookEvent;
    
    try {
      event = JSON.parse(body) as IncomingWebhookEvent;
      
      if (!event.type || !event.data) {
        return NextResponse.json(
          { error: 'Invalid event format. Expected { type, data } structure.' },
          { status: 400 }
        );
      }
    } catch (parseError) {
      console.error('[WEBHOOKS] Failed to parse webhook payload:', parseError);
      return NextResponse.json(
        { error: 'Failed to parse JSON payload' },
        { status: 400 }
      );
    }

    // 2. Verify signature (if secret is configured)
    if (WEBHOOK_SECRET) {
      const signature = request.headers.get('x-webhook-signature');
      
      if (!signature) {
        console.warn('[WEBHOOKS] No signature header provided for signed webhook');
        return NextResponse.json(
          { error: 'Missing x-webhook-signature header' },
          { status: 401 }
        );
      }

      const valid = handleVerification(body, signature, WEBHOOK_SECRET);
      
      if (!valid) {
        console.error('[WEBHOOKS] Invalid webhook signature rejected!');
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 403 }
        );
      }
    }

    // 3. Route to appropriate handler based on event type
    switch (event.type) {
      case 'feedback.submitted':
        await processFeedbackEvent(event);
        break;
        
      case 'nps.response':
        await processNpsEvent(event);
        break;
        
      case 'payment.received':
        await processPaymentEvent(event);
        break;
        
      default:
        console.log(`[WEBHOOKS] Unhandled event type: ${event.type}`);
    }

    // 4. Dispatch to any registered endpoints (external integrations)
    const results = await dispatchEvent({
      id: crypto.randomUUID(),
      type: event.type,
      timestamp: new Date(),
      data: event.data,
    });
    
    console.log(`[WEBHOOKS] Processed ${event.type} successfully (${results.length} endpoints notified)`);

    // 5. Return success response
    return NextResponse.json({ 
      status: 'ok', 
      event_type: event.type,
      endpoints_notified: results.length,
    });

  } catch (error) {
    console.error('[WEBHOOKS] Unhandled error processing webhook:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// --- Health Check & Endpoint Registration (GET) ---

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    
    switch (action) {
      case 'health':
        return NextResponse.json({ 
          status: 'healthy',
          endpoints_active: Object.keys(getActiveEndpoints('*')).length,
          timestamp: new Date().toISOString(),
        });
        
      case 'register':
        const endpointUrl = url.searchParams.get('url');
        if (!endpointUrl) {
          return NextResponse.json(
            { error: 'Missing ?url= parameter' },
            { status: 400 }
          );
        }
        
        const id = registerEndpoint({
          url: endpointUrl,
          secret: WEBHOOK_SECRET || '',
          events: ['*'], // Subscribe to all events
        });
        
        return NextResponse.json({ 
          message: 'Endpoint registered',
          endpoint_id: id,
          url: endpointUrl,
        });
        
      default:
        return NextResponse.json({ 
          status: 'ok',
          description: 'Tourbillon Webhooks API - Accepts incoming webhook events for feedback, NPS, and payment processing.',
          accepted_types: ['feedback.submitted', 'nps.response', 'payment.received'],
        });
    }
  } catch (error) {
    console.error('[WEBHOOKS] Error in GET handler:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
