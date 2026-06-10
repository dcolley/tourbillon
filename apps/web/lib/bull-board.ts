import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getQueue, JOB_QUEUES } from './queue';

const BASE_PATH = '/bullmq';

let app: Hono | undefined;

export function getBullBoardApp(): Hono {
  if (app) return app;

  const hono = new Hono();
  const serverAdapter = new HonoAdapter(serveStatic);

  createBullBoard({
    queues: JOB_QUEUES.map((q) => new BullMQAdapter(getQueue(q.name))),
    serverAdapter,
  });

  serverAdapter.setBasePath(BASE_PATH);
  hono.route(BASE_PATH, serverAdapter.registerPlugin());

  app = hono;
  return app;
}
