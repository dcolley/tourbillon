// ============================================================================
// TOUR-97: Slack Integration — Send Message Endpoint
// ============================================================================
// Programmatic API for sending messages to Slack channels.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { 
  sendToSlack, 
  buildFeedbackMessage, 
  buildAlertMessage, 
  checkSlackConnection,
} from '@/lib/slack/service';

// --- Validation Schemas ---

const sendMessageSchema = z.object({
  message: z.string().min(1, 'Message is required').max(5000),
  priority: z.enum(['critical', 'high', 'medium', 'low', 'normal']).default('normal'),
  channel: z.string().optional(),
  username: z.string().optional(),
  iconEmoji: z.string().optional(),
});

const sendFeedbackSchema = z.object({
  type: z.enum(['bug_report', 'feature_request', 'billing', 'complaint', 'general']).default('general'),
  subject: z.string().min(1, 'Subject is required').max(200),
  message: z.string().min(1, 'Message is required').max(5000),
  email: z.string().email('Invalid email address').optional(),
  channelOverride: z.string().optional(),
});

const sendAlertSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().min(1, 'Description is required').max(5000),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('normal'),
  channel: z.string().optional(),
});

// --- Route Handlers ---

/**
 * POST /api/slack/send — Send a message to Slack.
 * 
 * Supports three operation types via the `operation` field in request body:
 * - `message`: Generic formatted notification (default)
 * - `feedback`: Feedback-specific formatting with emoji and metadata
 * - `alert`: Priority-colored alert notification
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Determine operation type (defaults to 'message')
    const operation = body.operation || 'message';

    if (!['message', 'feedback', 'alert'].includes(operation)) {
      return NextResponse.json(
        { error: `Unknown operation: ${operation}. Must be one of: message, feedback, alert` },
        { status: 400 }
      );
    }

    // Check if Slack is configured before validating input (fail fast)
    const connectionStatus = await checkSlackConnection();
    if (!connectionStatus.ok) {
      return NextResponse.json(
        { error: 'Slack not configured', details: connectionStatus.error },
        { status: 503 }
      );
    }

    // Route to appropriate handler based on operation type
    switch (operation) {
      case 'message':
        return await handleSendMessage(body);
      case 'feedback':
        return await handleSendFeedback(body);
      case 'alert':
        return await handleSendAlert(body);
      default:
        return NextResponse.json(
          { error: `Unknown operation: ${operation}` },
          { status: 400 }
        );
    }

  } catch (error: any) {
    console.error('[SLACK-SEND] Error:', error.message);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/slack/send — Health check for the send endpoint.
 */
export async function GET() {
  const connectionStatus = await checkSlackConnection();

  return NextResponse.json({
    status: 'active',
    slackIntegration: true,
    configured: connectionStatus.ok,
    operationTypes: ['message', 'feedback', 'alert'],
    health: connectionStatus.ok ? 'ok' : `error: ${connectionStatus.error}`,
  });
}

// --- Internal Handlers ---

async function handleSendMessage(body: Record<string, any>): Promise<NextResponse> {
  const validationResult = sendMessageSchema.safeParse(body);
  
  if (!validationResult.success) {
    return NextResponse.json(
      { 
        error: 'Validation failed',
        details: validationResult.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }))
      },
      { status: 400 }
    );
  }

  const data = validationResult.data;

  const success = await sendToSlack({
    message: data.message,
    priority: data.priority,
    channel: data.channel,
    username: data.username,
    iconEmoji: data.iconEmoji,
  });

  if (!success) {
    return NextResponse.json(
      { error: 'Failed to send Slack message' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, sent: true, channel: data.channel });
}

async function handleSendFeedback(body: Record<string, any>): Promise<NextResponse> {
  const validationResult = sendFeedbackSchema.safeParse(body);
  
  if (!validationResult.success) {
    return NextResponse.json(
      { 
        error: 'Validation failed',
        details: validationResult.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }))
      },
      { status: 400 }
    );
  }

  const data = validationResult.data;
  
  // Build the Slack-formatted feedback message using service utility
  const slackMessage = buildFeedbackMessage(
    data.type,
    data.subject,
    data.message,
    data.email || undefined,
  );

  // Map feedback type to priority level
  const priorityMap: Record<string, 'critical' | 'high' | 'medium'> = {
    bug_report: 'high',
    complaint: 'critical',
    billing: 'high',
    feature_request: 'medium',
    general: 'medium',
  };

  const success = await sendToSlack({
    message: slackMessage,
    priority: data.channelOverride ? undefined : priorityMap[data.type],
    channel: data.channelOverride,
  });

  if (!success) {
    return NextResponse.json(
      { error: 'Failed to send feedback notification' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, sent: true, type: data.type });
}

async function handleSendAlert(body: Record<string, any>): Promise<NextResponse> {
  const validationResult = sendAlertSchema.safeParse(body);
  
  if (!validationResult.success) {
    return NextResponse.json(
      { 
        error: 'Validation failed',
        details: validationResult.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        }))
      },
      { status: 400 }
    );
  }

  const data = validationResult.data;
  
  // Build the alert using service utility
  const alertData = buildAlertMessage(data.title, data.description, data.priority);

  const success = await sendToSlack({
    message: alertData.text,
    priority: data.priority,
    channel: data.channel,
  });

  if (!success) {
    return NextResponse.json(
      { error: 'Failed to send alert' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, sent: true, title: data.title });
}
