/**
 * Test support for the AGUI-1b client (not imported by app code): a fake fetch for
 * POST /api/agui/[agentId] whose responses the test scripts event by event.
 */
type Ev = { type: string; [k: string]: unknown };

const enc = new TextEncoder();
export const sse = (events: Ev[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

export interface OpenStream {
  send(...events: Ev[]): void;
  /** Raw SSE text (e.g. keep-alive comments, split chunks). */
  raw(text: string): void;
  close(): void;
  fail(err?: Error): void;
  readonly aborted: boolean;
}

export interface FakeRequest {
  url: string;
  body: any;
  action: string;
  signal: AbortSignal;
}

export type Reply =
  | { kind: 'stream'; stream: OpenStream; response: Response }
  | { kind: 'response'; response: Response };

export function openStream(signal?: AbortSignal): { stream: OpenStream; response: Response } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      done = true;
    },
  });
  signal?.addEventListener('abort', () => {
    aborted = true;
    if (done) return;
    done = true;
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    ctrl.error(err);
  });
  const stream: OpenStream = {
    send: (...events) => {
      if (!done) ctrl.enqueue(enc.encode(sse(events)));
    },
    raw: (text) => {
      if (!done) ctrl.enqueue(enc.encode(text));
    },
    close: () => {
      if (done) return;
      done = true;
      ctrl.close();
    },
    fail: (err = new Error('network down')) => {
      if (done) return;
      done = true;
      ctrl.error(err);
    },
    get aborted() {
      return aborted;
    },
  };
  return { stream, response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) };
}

/** Control answer as the endpoint sends it (RUN_STARTED, tourbillon.control, RUN_FINISHED). */
export function controlResponse(body: any, value: Record<string, unknown>): Response {
  const action = body.forwardedProps?.tourbillon?.action;
  const full = { action, ...value };
  return new Response(
    sse([
      { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
      { type: 'CUSTOM', name: 'tourbillon.control', value: full },
      { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId, outcome: { type: 'success' }, result: full },
    ]),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * fetch double: each request is recorded and answered by `handler`, which may return a Response
 * or `'stream'` to get an open stream the test drives (via `streams`).
 */
export function createFakeAguiServer(handler: (req: FakeRequest) => Response | 'stream' | Promise<Response | 'stream'>) {
  const requests: FakeRequest[] = [];
  const streams: OpenStream[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const req: FakeRequest = {
      url: String(url),
      body,
      action: body.forwardedProps?.tourbillon?.action ?? 'run',
      signal: init.signal as AbortSignal,
    };
    requests.push(req);
    const out = await handler(req);
    if (out === 'stream') {
      const { stream, response } = openStream(req.signal);
      streams.push(stream);
      return response;
    }
    return out;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests, streams };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond()` holds (polling), failing after `ms`. */
export async function until(cond: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}
