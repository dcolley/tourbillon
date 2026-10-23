/** AGUI-1b: SSE reader for the AG-UI endpoint body. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AguiStreamParseError, createSseParser, readAguiEvents, type AguiClientEvent } from './sse';

const body = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? new TextEncoder().encode(ch) : ch);
      c.close();
    },
  });

async function readAll(stream: ReadableStream<Uint8Array>) {
  const out: AguiClientEvent[] = [];
  await readAguiEvents(stream, (e) => out.push(e));
  return out;
}

describe('AGUI-1b SSE reader', () => {
  it('parses data events, skips keep-alive comments', async () => {
    const events = await readAll(
      body('data: {"type":"RUN_STARTED","runId":"r"}\n\n: keep-alive\n\ndata: {"type":"RUN_FINISHED"}\n\n'),
    );
    assert.deepEqual(events, [{ type: 'RUN_STARTED', runId: 'r' }, { type: 'RUN_FINISHED' }]);
  });

  it('handles events and UTF-8 characters split across chunks, CRLF, and `data:` without a space', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"héllo ✓"}\r\n\r\ndata:{"type":"X"}\n\n');
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 47), bytes.slice(47, 49), bytes.slice(49)];
    const events = await readAll(body(...chunks));
    assert.deepEqual(events, [{ type: 'TEXT_MESSAGE_CONTENT', delta: 'héllo ✓' }, { type: 'X' }]);
  });

  it('a trailing event without its blank line is still delivered at end of stream', async () => {
    assert.deepEqual(await readAll(body('data: {"type":"RUN_FINISHED"}')), [{ type: 'RUN_FINISHED' }]);
  });

  it('multi-line data is joined', () => {
    const p = createSseParser();
    assert.deepEqual(p.push('data: {"type":\ndata: "A"}\n\n'), [{ type: 'A' }]);
  });

  it('malformed JSON or an event without a type is an error', () => {
    assert.throws(() => createSseParser().push('data: {nope\n\n'), AguiStreamParseError);
    assert.throws(() => createSseParser().push('data: {"x":1}\n\n'), AguiStreamParseError);
  });
});
