// ============================================================================
// TOUR-121: Webhook Endpoints API - CRUD Operations
// 
// GET    /api/webhooks/endpoints  - List all webhook endpoints
// POST   /api/webhooks/endpoints  - Create a new webhook endpoint
// ============================================================================

import { NextResponse } from 'next/server';

interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string; // For signature verification in production
  active: boolean;
  events: string[];
  lastDelivered?: Date | null;
  createdAt: Date;
}

// In-memory store (replace with database for production)
const endpointsStore = new Map<string, WebhookEndpoint>();
let endpointCounter = 0;

/**
 * GET - List all webhook endpoints
 */
export async function GET(): Promise<NextResponse> {
  try {
    const endpoints = Array.from(endpointsStore.values());
    
    console.log('[WEBHOOKS API] Retrieved ' + endpoints.length + ' endpoint(s)');

    return NextResponse.json({ 
      endpoints: endpoints.map(ep => ({
        id: ep.id,
        url: ep.url,
        active: ep.active,
        events: ep.events,
        lastDelivered: ep.lastDelivered,
        createdAt: ep.createdAt,
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
    const { url, events }: { url: string; events: string[] } = body;

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

    const validEventTypes = [
      'feedback.submitted',
      'nps.response', 
      'user.created',
      'payment.received',
      'custom.*'
    ];

    for (const event of events) {
      if (!validEventTypes.includes(event)) {
        return NextResponse.json(
          { error: `Invalid event type: ${event}` },
          { status: 400 }
        );
      }
    }

    // Generate unique ID and secret for this endpoint
    const id = 'endpoint_' + (++endpointCounter) + '_' + Date.now();
    
    // Create the endpoint object
    const newEndpoint: WebhookEndpoint = {
      id,
      url,
      secret: crypto.randomUUID(), // Unique secret per endpoint
      active: true,
      events,
      lastDelivered: null,
      createdAt: new Date(),
    };

    // Store in memory (in production, save to database)
    endpointsStore.set(id, newEndpoint);

    console.log('[WEBHOOKS API] Created webhook endpoint ' + id + ' for URL: ' + url);

    return NextResponse.json({ 
      message: 'Webhook endpoint created successfully',
      ...newEndpoint
    }, { status: 201 });
  } catch (error) {
    console.error('[WEBHOOKS API] Error creating endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to create webhook endpoint' },
      { status: 500 }
    );
  }
}
