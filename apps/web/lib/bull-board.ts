import { createBullBoard } from '@bull-board/api';
import { HonoAdapter } from '@bull-board/hono';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

const BASE_PATH = '/bullmq';

let app: Hono | undefined;

/** Bull Board shell — no heartbeat queues registered after Phase 2. */
export function getBullBoardApp(): Hono {
  if (app) return app;

  const hono = new Hono();
  const serverAdapter = new HonoAdapter(serveStatic);

  createBullBoard({
    queues: [],
    serverAdapter,
  });

  serverAdapter.setBasePath(BASE_PATH);
  hono.route(BASE_PATH, serverAdapter.registerPlugin());

  hono.get(BASE_PATH, (c) =>
    c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>BullMQ</h1>
        <p>Heartbeat and approval queues have been removed. Monitor wakes at <a href="/jobs/heartbeat">/jobs/heartbeat</a>.</p>
      </body></html>`,
    ),
  );

  app = hono;
  return app;
}
