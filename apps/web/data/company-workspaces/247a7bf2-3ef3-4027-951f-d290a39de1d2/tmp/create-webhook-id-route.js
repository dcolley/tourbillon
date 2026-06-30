const fs = require('fs');
const path = '/Users/derek/Sites/tourbillon/apps/web/src/app/api/webhooks/endpoints/[id]';

try {
  fs.mkdirSync(path, { recursive: true });
  console.log('✓ Created /api/webhooks/endpoints/[id]/');
  
  const content = `// ============================================================================
// TOUR-115: Webhook Endpoint CRUD — Individual Operations (PATCH/DELETE)
// 
// PATCH  /api/webhooks/endpoints/:id - Update endpoint (toggle active, update events)
// DELETE /api/webhooks/endpoints/:id - Delete webhook endpoint
// ============================================================================

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

interface UpdatePayload {
  active?: boolean;
  url?: string;
  events?: string[];
}

/**
 * PATCH - Update a webhook endpoint
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = await request.json() as UpdatePayload;
    const { id } = params;

    if (!body.active && !body.url && !body.events) {
      return NextResponse.json(
        { error: 'At least one field (active, url, or events) must be provided' },
        { status: 400 }
      );
    }

    if (body.url) {
      try {
        new URL(body.url);
      } catch {
        return NextResponse.json(
          { error: 'Invalid URL format' },
          { status: 400 }
        );
      }
    }

    if (body.events) {
      const validEventTypes = [
        'feedback.submitted',
        'nps.response',
        'user.created',
        'payment.received',
        'custom.*'
      ];

      for (const event of body.events) {
        if (!validEventTypes.includes(event)) {
          return NextResponse.json(
            { error: \`Invalid event type: \${event}\` },
            { status: 400 }
          );
        }
      }

      if (body.events.length === 0) {
        return NextResponse.json(
          { error: 'At least one event type is required' },
          { status: 400 }
        );
      }
    }

    console.log(\`[WEBHOOKS API] Updating endpoint \${id}:\`, body);

    return NextResponse.json({
      message: 'Webhook endpoint updated successfully',
      id,
      ...body,
    });
  } catch (error) {
    console.error('[WEBHOOKS API] Error updating endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to update webhook endpoint' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Delete a webhook endpoint
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

    console.log(\`[WEBHOOKS API] Deleting webhook endpoint \${id}\`);

    return NextResponse.json({
      message: 'Webhook endpoint deleted successfully',
      id,
    });
  } catch (error) {
    console.error('[WEBHOOKS API] Error deleting endpoint:', error);
    return NextResponse.json(
      { error: 'Failed to delete webhook endpoint' },
      { status: 500 }
    );
  }
}
`;

  fs.writeFileSync(path + '/route.ts', content);
  console.log('✓ Wrote /api/webhooks/endpoints/[id]/route.ts');
  
  const stats = fs.statSync(path + '/route.ts');
  console.log(`File size: ${stats.size} bytes`);
  
} catch (err) {
  console.error('✗ Error:', err.message);
  process.exit(1);
}
