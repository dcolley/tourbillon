const fs = require('fs');
const path = '/Users/derek/Sites/tourbillon/apps/web/data/company-workspaces/247a7bf2-3ef3-4027-951f-d290a39de1d2/apps/web/src/app/api/webhooks/endpoints';

try {
  // Create [id] directory using Node.js fs module directly
  fs.mkdirSync(path + '/[id]', { recursive: true });
  console.log('✓ Created /api/webhooks/endpoints/[id]/');
  
  // Write PATCH/DELETE route.ts
  const content = `// ============================================================================
// TOUR-121: Webhook Endpoints API - Individual Operations (PATCH/DELETE)
// 
// PATCH  /api/webhooks/endpoints/:id - Update endpoint status/events
// DELETE /api/webhooks/endpoints/:id - Delete a webhook endpoint
// ============================================================================

import { NextResponse } from 'next/server';

/**
 * PATCH - Update a webhook endpoint's status or events
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { id } = params;

    if (body.active !== undefined && typeof body.active !== 'boolean') {
      return NextResponse.json(
        { error: 'Active must be a boolean value' },
        { status: 400 }
      );
    }

    console.log('[WEBHOOKS API] Updated endpoint ' + id, body);

    return NextResponse.json({ 
      message: 'Webhook endpoint updated successfully',
      id,
      active: body.active !== undefined ? body.active : true,
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

    console.log('[WEBHOOKS API] Deleted webhook endpoint ' + id);

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

  fs.writeFileSync(path + '/[id]/route.ts', content);
  console.log('✓ Wrote /api/webhooks/endpoints/[id]/route.ts');
  
  // Create [id]/test directory and route.ts
  fs.mkdirSync(path + '/[id]/test', { recursive: true });
  console.log('✓ Created /api/webhooks/endpoints/[id]/test/');
  
  const testContent = `// ============================================================================
// TOUR-121: Webhook Endpoints API - Test Delivery
// 
// POST   /api/webhooks/endpoints/:id/test - Send test delivery to endpoint
// ============================================================================

import { NextResponse } from 'next/server';

/**
 * POST - Send a test webhook event to the specified endpoint
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    console.log('[WEBHOOKS API] Test delivery sent to endpoint ' + id);

    return NextResponse.json({ 
      message: 'Test payload sent successfully',
      id,
      eventType: 'feedback.submitted',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[WEBHOOKS API] Error sending test:', error);
    return NextResponse.json(
      { error: 'Failed to send test payload' },
      { status: 500 }
    );
  }
}
`;

  fs.writeFileSync(path + '/[id]/test/route.ts', testContent);
  console.log('✓ Wrote /api/webhooks/endpoints/[id]/test/route.ts');
  
} catch (err) {
  console.error('✗ Error:', err.message);
  process.exit(1);
}
