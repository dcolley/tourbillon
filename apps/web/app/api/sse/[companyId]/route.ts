import { NextRequest } from 'next/server';
import { getSseSubscribers } from '@/lib/sse';

/**
 * Server-Sent Events endpoint for real-time dashboard updates.
 * Clients subscribe to company-level events.
 * Uses a simple in-memory broadcast for the prototype.
 * Production: replace with Redis pub/sub.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          // Client disconnected
        }
      };

      getSseSubscribers(companyId).add(send);

      send(`data: ${JSON.stringify({ type: 'connected', companyId })}\n\n`);

      req.signal.addEventListener('abort', () => {
        getSseSubscribers(companyId).delete(send);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
