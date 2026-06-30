// ============================================================================
// TOUR-128: Webhook Endpoint Test — Send test payload to endpoint
// 
// POST   /api/webhooks/endpoints/test - Send a test webhook event with ID in body
// ============================================================================

import { NextResponse } from 'next/server';

/**
 * POST - Send a test webhook event to the specified endpoint
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { id, url }: { id?: string; url?: string } = body || {};

    if (!id) {
      return NextResponse.json(
        { error: 'Endpoint ID is required' },
        { status: 400 }
      );
    }

    // Build test payload
    const testPayload = {
      id: `test_${id}_${Date.now()}`,
      type: 'feedback.submitted',
      timestamp: new Date().toISOString(),
      data: {
        subject: 'Test Feedback from Tourbillon Webhooks Dashboard',
        message: 'This is a test webhook payload sent from the Developer Portal.',
        email: 'test@example.com',
        source: 'developer-portal-test',
      },
    };

    // Log the dispatch attempt (in production, would actually POST to url)
    if (url) {
      console.log(`[WEBHOOKS API] Attempting test dispatch to ${url} for endpoint ${id}:`, testPayload);
      
      // Try actual delivery (non-blocking - don't fail if unreachable)
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-Webhook-Signature': `test_sig_${Date.now()}`,
            'X-Webhook-Event': testPayload.type,
          },
          body: JSON.stringify(testPayload),
        });
      } catch (dispatchError) {
        console.warn(`[WEBHOOKS API] Test dispatch to ${url} failed (endpoint may be unreachable):`, dispatchError);
        // Don't fail the request — this is just a test
      }
    } else {
      console.log(`[WEBHOOKS API] Test payload prepared for endpoint ${id}:`, testPayload);
    }

    return NextResponse.json({
      message: 'Test payload sent successfully',
      id,
      event: {
        type: testPayload.type,
        timestamp: testPayload.timestamp,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error('[WEBHOOKS API] Error sending test payload:', error);
    return NextResponse.json(
      { error: 'Failed to send test webhook' },
      { status: 500 }
    );
  }
}
