import { handle } from 'hono/vercel';
import { getBullBoardApp } from '@/lib/bull-board';

const app = getBullBoardApp();

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
