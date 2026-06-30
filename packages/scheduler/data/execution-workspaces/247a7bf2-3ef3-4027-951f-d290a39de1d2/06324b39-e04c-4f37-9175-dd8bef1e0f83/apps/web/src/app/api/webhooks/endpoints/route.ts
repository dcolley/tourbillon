// ============================================================================
// TOUR-128: Webhook Endpoints API — CRUD Operations (updated with shared store)
// 
// GET    /api/webhooks/endpoints  - List all webhook endpoints
// POST   /api/webhooks/endpoints  - Create a new webhook endpoint
// ============================================================================

import { NextResponse } from 'next/server';
import { webhookStore } from '@/lib/webhooks/store';

interface ValidEventTypes {
  [key: string]: boolean;
}

const VALID_EVENTS: ValidEventTypes = {
  'feedback.submitted': true,
  'nps.response': true,
  'user.created': true,
  'payment.received': true,
  'custom.*': true,
};

/**
 * GET - List all webhook endpoints
 */
export async function GET(): Promise<NextResponse> {
  try {
    const endpoints = webhookStore.getAll();
    
    console.log('[WEBHOOKS API] Retrieved ' + endpoints.length + ' endpoint(s)');

    return NextResponse.json({ 
      endpoints: endpoints.map(ep => ({
        id: ep.id,
        url: ep.url,
        active: ep.active,
        events: ep.events,
        lastDelivered: ep.lastDelivered,
        createdAt: ep.createdAt.toISOString(),
      }))
    });
  } catch (error) {
    console.error('[WEBHOOKS API] Error listing endpoints:', error);
    return NextResponse.json(
      { error: 'Failed to fetch webhook endpoints' },
      { status: 500 }
    );
  }
}

/**
 * POST - Create a new webhook endpoint
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { url, events }: { url?: string; events?: string[] } = body || {};

    // Validate URL format
    if (!url) {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    // Validate events array
    if (!events || !Array.isArray(events) || events.length === 0) {
      return NextResponse.json(
        { error: 'At least one event type is required' },
        { status: 400 }
      );
    }

    for (const event of events) {
      if (!VALID_EVENTS[event]) {
        return NextResponse.json(
          { error: `Invalid event type: ${event}` },
          { status: 400 }
        );
      }
    }

    // Create the endpoint using shared store
    const newEndpoint = webhookStore.create(url, events);

    console.log('[WEBHOOKS API] Created webhook endpoint ' + newEndpoint.id);

    return NextResponse.json({ 
      message: 'Webhook endpoint created successfully',
      id: newEndpoint.id,
      url: newEndpoint.url,
      active: newEndpoint.active,
      events: newEndpoint.events,
      lastDelivered: null,
      createdAt: newEndpoint.createdAt.toISOString(),
    }, { status: 201 });
  } catch (error) {
    console.error('[WEBHOOKS API] Error creating endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to create webhook endpoint' },
      { status: 500 }
    );
  }
}
