import { NextRequest } from 'next/server';
import { getSseSubscribers } from '@/lib/sse';
import { requireBoardCompany } from '@/lib/board-route-auth';

/**
 * Server-Sent Events endpoint for real-time dashboard updates.
 * Clients subscribe to company-level events via Redis pub/sub.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;

  // #106: board only, and only the board's own company stream (another company → 403).
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return auth.response;
  if (auth.value.id !== companyId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

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
