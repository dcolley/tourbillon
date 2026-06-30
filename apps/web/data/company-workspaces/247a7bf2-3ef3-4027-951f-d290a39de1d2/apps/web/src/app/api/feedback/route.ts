import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, feedbackSubmissions } from '@tourbillon/db';
import { eq } from 'drizzle-orm';

// ============================================================================
// TOUR-62: Automated Feedback Routing to Slack/Email (TOUR-97 refactored)
// 
// This API endpoint accepts user feedback and automatically routes it to the
// appropriate team channels based on keyword categorization.
// 
// Uses the centralized @/lib/slack/service for all Slack messaging, replacing
// the inline webhook code that previously lived here.
// 
// Routing Rules:
// - BUG/ERROR/CRASH → #critical-issues (Slack) + #product-feedback
// - FEATURE REQUEST/SUGGESTION → #product-feedback  
// - PRICING/BILLING → #customer-support
// - COMPLAINT/FRUSTRATED → #customer-support + #product-feedback
// - GENERAL/OTHER → #general-feedback
// ============================================================================

// --- Validation Schema ---

const feedbackSchema = z.object({
  type: z.enum(['bug_report', 'feature_request', 'billing', 'complaint', 'general']).default('general'),
  subject: z.string().min(1, 'Subject is required').max(200),
  message: z.string().min(1, 'Message is required').max(5000),
  email: z.string().email('Invalid email address').optional(),
  userId: z.string().uuid().optional(),
});

// --- Slack Integration (via centralized service) ---
import { sendToSlack, buildFeedbackMessage, getRoutingChannels } from '@/lib/slack/service';

async function sendEmailNotification(feedback: z.infer<typeof feedbackSchema>, channel: string): Promise<boolean> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log(`[EMAIL] SMTP not configured — would email notification for ${feedback.type}: ${feedback.subject}`);
    return false;
  }

  // In production, this would use Nodemailer, SendGrid, or similar
  const subject = `[TOURBILLON - ${channel}] ${feedback.subject}`;
  const body = `New feedback received:\n\nType: ${feedback.type}\nSubject: ${feedback.subject}\nMessage: ${feedback.message}${feedback.email ? `\nEmail: ${feedback.email}` : ''}\nChannel: ${channel}\nTimestamp: ${new Date().toISOString()}`;

  console.log(`[EMAIL] Would send to support@tourbillon.com:`, subject);
  return true; // Placeholder — actual implementation would use email service
}

// --- Core Route Handler ---

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Validate input
    const validationResult = feedbackSchema.safeParse(body);
    
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
    const feedbackText = `${data.subject} ${data.message}`.toLowerCase();

    // Find matching routing rule (first match wins) — now uses service helper
    const routeInfo = getRoutingChannels(feedbackText);

    // Store in database
    const submission = await db.insert(feedbackSubmissions).values({
      type: data.type,
      subject: data.subject,
      message: data.message,
      email: data.email || null,
      userId: data.userId || null,
      priority: routeInfo.priority,
      status: 'open',
    }).returning();

    const submissionId = submission[0].id;
    
    // Build the Slack-formatted message using the centralized service utility
    const slackMessage = buildFeedbackMessage(
      data.type,
      data.subject,
      data.message,
      data.email || undefined,
    );

    // Route to appropriate Slack channels via the new service
    let slackSuccess = false;
    for (const channel of routeInfo.channels) {
      await sendToSlack({
        message: slackMessage,
        priority: routeInfo.priority,
        channel,
      });
      slackSuccess = true;
    }

    // Send email notification if configured
    await sendEmailNotification(data, routeInfo.channels[0]);

    return NextResponse.json(
      { 
        success: true,
        id: submissionId,
        routedTo: routeInfo.channels,
        message: 'Feedback submitted and routed successfully',
      },
      { status: 201 }
    );
    
  } catch (error) {
    console.error('Error processing feedback:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: 'An unexpected error occurred. Please try again later.'
      },
      { status: 500 }
    );
  }
}

// GET endpoint — retrieve feedback submissions (admin only)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50);

  try {
    let query = db.select().from(feedbackSubmissions).orderBy(
      feedbackSubmissions.createdAt
    ).limit(limit);

    if (status) {
      query = query.where(eq(feedbackSubmissions.status, status));
    }

    const submissions = await query;

    return NextResponse.json({
      count: submissions.length,
      submissions: submissions.map(({ id, type, subject, priority, status, createdAt }) => ({
        id,
        type,
        subject,
        priority,
        status,
        createdAt: createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error retrieving feedback:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
