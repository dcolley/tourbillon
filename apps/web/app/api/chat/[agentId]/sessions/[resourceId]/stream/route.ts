import { NextRequest } from 'next/server';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

function toWireEvent(event: unknown): unknown {
  if (
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'error' &&
    (event as { error?: unknown }).error instanceof Error
  ) {
    const error = (event as { error: Error }).error;
    return { ...event, error: { name: error.name, message: error.message } };
  }
  return event;
}

/** SSE stream of AgentController session events. Does not replay history. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });

    const encoder = new TextEncoder();
    let cleanedUp = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const stream = new ReadableStream({
      start(ctrl) {
        const clearHeartbeat = () => {
          if (heartbeat) {
            clearTimeout(heartbeat);
            heartbeat = undefined;
          }
        };

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          clearHeartbeat();
          unsubscribe?.();
          try {
            ctrl.close();
          } catch {
            /* already closed */
          }
        };

        const scheduleHeartbeat = () => {
          if (cleanedUp) return;
          clearHeartbeat();
          heartbeat = setTimeout(() => {
            heartbeat = undefined;
            if (cleanedUp) return;
            try {
              ctrl.enqueue(encoder.encode(': heartbeat\n\n'));
            } catch {
              cleanup();
              return;
            }
            scheduleHeartbeat();
          }, 25_000);
        };

        unsubscribe = session.subscribe((event) => {
          if (cleanedUp) return;
          try {
            const data = JSON.stringify(toWireEvent(event));
            ctrl.enqueue(encoder.encode(`data: ${data}\n\n`));
            scheduleHeartbeat();
          } catch {
            cleanup();
          }
        });

        req.signal.addEventListener('abort', cleanup, { once: true });
        scheduleHeartbeat();
        // Flush so the client knows the stream is live
        ctrl.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        cleanedUp = true;
        if (heartbeat) clearTimeout(heartbeat);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
