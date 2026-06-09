import { NextRequest } from 'next/server';

/**
 * Server-Sent Events endpoint for real-time dashboard updates.
 * Clients subscribe to company-level events.
 * Uses a simple in-memory broadcast for the prototype.
 * Production: replace with Redis pub/sub.
 */

const subscribers = new Map<string, Set<(data: string) => void>>();

export function broadcastSSE(companyId: string, event: object): void {
  const subs = subscribers.get(companyId);
  if (!subs) return;
  const message = `data: ${JSON.stringify(event)}\n\n`;
  subs.forEach((send) => send(message));
}

export async function GET(
  req: NextRequest,
  { params }: { params: { companyId: string } }
) {
  const { companyId } = params;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          // Client disconnected
        }
      };

      if (!subscribers.has(companyId)) subscribers.set(companyId, new Set());
      subscribers.get(companyId)!.add(send);

      // Send initial connection event
      send(`data: ${JSON.stringify({ type: 'connected', companyId })}\n\n`);

      // Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        subscribers.get(companyId)?.delete(send);
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
