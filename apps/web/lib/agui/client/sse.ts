/**
 * AGUI-1b: reads the AG-UI SSE body sent by POST /api/agui/[agentId] (lib/agui/session-stream.ts):
 * `data: <json>` lines, blank-line separated, plus `: keep-alive` comment lines. Browser and Node
 * safe (fetch ReadableStream + TextDecoder); no dependency on the AG-UI client package.
 */
export interface AguiClientEvent {
  type: string;
  [key: string]: unknown;
}

export class AguiStreamParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AguiStreamParseError';
  }
}

/** Incremental SSE parser: feed text chunks, get complete events back. */
export function createSseParser() {
  let buffer = '';
  let data: string[] = [];

  const flush = (out: AguiClientEvent[]) => {
    if (data.length === 0) return;
    const json = data.join('\n');
    data = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AguiStreamParseError('Malformed AG-UI event');
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      throw new AguiStreamParseError('AG-UI event without a type');
    }
    out.push(parsed as AguiClientEvent);
  };

  return {
    push(chunk: string): AguiClientEvent[] {
      const out: AguiClientEvent[] = [];
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') flush(out);
        else if (line.startsWith(':')) continue; // comment / keep-alive
        else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        // other SSE fields (event:, id:, retry:) are not used by this endpoint
      }
      return out;
    },
    /** End of stream: a trailing event without its blank line still counts. */
    end(): AguiClientEvent[] {
      const out: AguiClientEvent[] = [];
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = '';
        out.push(...this.push(`${rest}\n`));
      }
      flush(out);
      return out;
    },
  };
}

/** Reads every event from an SSE body, calling `onEvent` in order. Resolves when the body ends. */
export async function readAguiEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AguiClientEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
    }
    for (const ev of parser.push(decoder.decode())) onEvent(ev);
    for (const ev of parser.end()) onEvent(ev);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
