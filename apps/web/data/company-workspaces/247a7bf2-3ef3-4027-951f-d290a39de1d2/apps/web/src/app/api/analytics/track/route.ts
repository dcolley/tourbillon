/**
 * Mixpanel Analytics API Endpoint — TOUR-147
 * 
 * Server-side endpoint for tracking Mixpanel events.
 * This allows client-side fallback when direct browser SDK can't be used,
 * or for tracking server-initiated events that need to appear as user actions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { trackEvent, identifyUser, setUserProperties } from '@/lib/mixpanel/server';
import { validate } from 'uuid';

// ============================================================================
// REQUEST VALIDATION
// ============================================================================

interface TrackRequest {
  event: string;        // Event name (required)
  distinct_id?: string; // User ID (optional — falls back to anonymous)
  properties?: Record<string, any>; // Custom properties (optional)
}

function validateRequestBody(body: unknown): body is TrackRequest {
  if (!body || typeof body !== 'object') return false;
  
  const data = body as Partial<TrackRequest>;
  
  if (!data.event || typeof data.event !== 'string') return false;
  if (data.distinct_id && typeof data.distinct_id !== 'string') return false;
  if (data.properties && typeof data.properties !== 'object') return false;
  
  // Validate distinct_id format if provided
  if (data.distinct_id && !validate(data.distinct_id)) {
    return false;
  }
  
  return true;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Track a single event.
 * POST /api/analytics/track
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    if (!validateRequestBody(body)) {
      return NextResponse.json(
        { error: 'Invalid request body', details: [
          'event (string, required)',
          'distinct_id (UUID string, optional)',
          'properties (object, optional)',
        ]},
        { status: 400 }
      );
    }

    const { event, distinct_id, properties } = body;
    
    // Use anonymous ID if not provided
    const userId = distinct_id || `anonymous-${Date.now()}`;

    // Track the event
    const success = await trackEvent({
      distinct_id: userId,
      event_name: event,
      properties,
    });

    if (!success) {
      // Silently fail — don't break user flow if Mixpanel is down
      return NextResponse.json(
        { success: true }, // Pretend it worked to avoid breaking the client
        { status: 200 }
      );
    }

    return NextResponse.json({ 
      success: true,
      event,
    });

  } catch (error) {
    console.error('Analytics track endpoint error:', error);
    
    // Always return success to not break client UX
    return NextResponse.json(
      { success: true },
      { status: 200 }
    );
  }
}

/**
 * Identify a user.
 * POST /api/analytics/identify
 */
export async function identify(request: NextRequest) {
  try {
    const body = await request.json();
    
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { distinct_id, properties } = body;
    
    if (!distinct_id || typeof distinct_id !== 'string') {
      return NextResponse.json(
        { error: 'distinct_id (string) is required' },
        { status: 400 }
      );
    }

    const success = await identifyUser({
      distinct_id,
      properties,
    });

    if (!success) {
      return NextResponse.json(
        { success: true }, // Graceful degradation
        { status: 200 }
      );
    }

    return NextResponse.json({ 
      success: true,
      user_id: distinct_id,
    });

  } catch (error) {
    console.error('Analytics identify endpoint error:', error);
    
    return NextResponse.json(
      { success: true },
      { status: 200 }
    );
  }
}

/**
 * Set user properties.
 * POST /api/analytics/properties
 */
export async function setProperties(request: NextRequest) {
  try {
    const body = await request.json();
    
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { distinct_id, properties } = body;
    
    if (!distinct_id || typeof distinct_id !== 'string') {
      return NextResponse.json(
        { error: 'distinct_id (string) is required' },
        { status: 400 }
      );
    }

    if (!properties || typeof properties !== 'object') {
      return NextResponse.json(
        { error: 'properties (object) is required' },
        { status: 400 }
      );
    }

    const success = await setUserProperties({
      distinct_id,
      properties,
    });

    if (!success) {
      return NextResponse.json(
        { success: true }, // Graceful degradation
        { status: 200 }
      );
    }

    return NextResponse.json({ 
      success: true,
      user_id: distinct_id,
    });

  } catch (error) {
    console.error('Analytics properties endpoint error:', error);
    
    return NextResponse.json(
      { success: true },
      { status: 200 }
    );
  }
}

/**
 * GET endpoint to check if analytics is enabled.
 */
export async function GET() {
  const isEnabled = !!process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
  
  return NextResponse.json({ 
    mixpanel_enabled: isEnabled,
    version: '1.0.0',
  });
}
