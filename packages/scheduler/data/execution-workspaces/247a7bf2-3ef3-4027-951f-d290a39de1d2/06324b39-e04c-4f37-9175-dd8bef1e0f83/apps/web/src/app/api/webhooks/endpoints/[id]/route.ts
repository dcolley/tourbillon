// ============================================================================
// TOUR-128: Webhook Endpoints API — Individual endpoint operations (shared store)
// 
// PATCH  /api/webhooks/endpoints/:id - Update a webhook endpoint (toggle active, update events)
// DELETE /api/webhooks/endpoints/:id - Remove a webhook endpoint
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
 * PATCH - Update a webhook endpoint
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Invalid endpoint ID' },
        { status: 400 }
      );
    }

    // Find the endpoint
    const existingEndpoint = webhookStore.getById(id);
    if (!existingEndpoint) {
      return NextResponse.json(
        { error: 'Webhook endpoint not found' },
        { status: 404 }
      );
    }

    // Parse request body
    let updates: Partial<{ active?: boolean; events?: string[]; url?: string }>;
    try {
      updates = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    // Validate URL if provided (must be valid format)
    if (updates.url !== undefined && updates.url !== existingEndpoint.url) {
      try {
        new URL(updates.url);
      } catch {
        return NextResponse.json(
          { error: 'Invalid URL format' },
          { status: 400 }
        );
      }
    }

    // Validate events if provided
    if (updates.events !== undefined) {
      if (!Array.isArray(updates.events)) {
        return NextResponse.json(
          { error: 'Events must be an array' },
          { status: 400 }
        );
      }

      if (updates.events.length === 0) {
        return NextResponse.json(
          { error: 'At least one event type is required' },
          { status: 400 }
        );
      }

      for (const event of updates.events) {
        if (!VALID_EVENTS[event]) {
          return NextResponse.json(
            { error: `Invalid event type: ${event}` },
            { status: 400 }
          );
        }
      }
    }

    // Apply updates via shared store
    const updatedEndpoint = webhookStore.update(id, updates);
    
    if (!updatedEndpoint) {
      return NextResponse.json(
        { error: 'Webhook endpoint not found' },
        { status: 404 }
      );
    }

    console.log(`[WEBHOOKS API] Updated webhook endpoint ${id}: active=${updatedEndpoint.active}, events=${updatedEndpoint.events.length} events`);

    return NextResponse.json({ 
      message: 'Webhook endpoint updated successfully',
      id: updatedEndpoint.id,
      url: updatedEndpoint.url,
      active: updatedEndpoint.active,
      events: updatedEndpoint.events,
      lastDelivered: updatedEndpoint.lastDelivered?.toISOString() ?? null,
      createdAt: updatedEndpoint.createdAt.toISOString(),
    });

  } catch (error) {
    console.error('[WEBHOOKS API] Error updating webhook endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to update webhook endpoint' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove a webhook endpoint
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Invalid endpoint ID' },
        { status: 400 }
      );
    }

    // Find the endpoint to delete
    const existingEndpoint = webhookStore.getById(id);
    if (!existingEndpoint) {
      return NextResponse.json(
        { error: 'Webhook endpoint not found' },
        { status: 404 }
      );
    }

    // Remove from store via shared singleton
    const deleted = webhookStore.delete(id);

    console.log(`[WEBHOOKS API] Deleted webhook endpoint ${id}`);

    return NextResponse.json({ 
      message: 'Webhook endpoint deleted successfully',
      id,
    });

  } catch (error) {
    console.error('[WEBHOOKS API] Error deleting webhook endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to delete webhook endpoint' },
      { status: 500 }
    );
  }
}
