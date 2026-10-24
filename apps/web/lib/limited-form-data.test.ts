/** CHAT-1 hardening: upload bodies are counted while streaming and aborted past the limit. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readLimitedFormData } from './limited-form-data';

/** A chunked body of `total` bytes (1 MiB chunks) that records how much was pulled and whether it was cancelled. */
function trackedBody(total: number, chunk = 1024 * 1024, prefix = new Uint8Array()) {
  const stats = { pulled: 0, cancelled: false };
  let sentPrefix = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentPrefix && prefix.length) {
        sentPrefix = true;
        stats.pulled += prefix.length;
        controller.enqueue(prefix);
        return;
      }
      if (stats.pulled >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, total - stats.pulled);
      stats.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
    cancel() {
      stats.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

const MB = 1024 * 1024;
const multipartHead = (boundary: string) =>
  new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`,
  );

function streamedRequest(body: ReadableStream<Uint8Array>, boundary = 'XBOUNDARY', headers: Record<string, string> = {}) {
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('CHAT-1 hardening readLimitedFormData', () => {
  it('a large chunked body is aborted soon after the limit, not read in full', async () => {
    const { stream, stats } = trackedBody(512 * MB, MB, multipartHead('XBOUNDARY'));
    const r = await readLimitedFormData(streamedRequest(stream), 10 * MB);
    assert.deepEqual(r, { ok: false, reason: 'too_large' });
    assert.ok(stats.pulled <= 13 * MB, `pulled ${stats.pulled} bytes`);
    assert.equal(stats.cancelled, true, 'source cancelled');
  });

  it('a declared Content-Length over the limit is refused without reading', async () => {
    const { stream, stats } = trackedBody(1 * MB);
    const r = await readLimitedFormData(streamedRequest(stream, 'B', { 'content-length': String(20 * MB) }), 10 * MB);
    assert.deepEqual(r, { ok: false, reason: 'too_large' });
    assert.equal(stats.pulled, 0);
  });

  it('a body within the limit parses', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'a.txt'));
    form.append('x', '1');
    const encoded = new Request('http://localhost/', { method: 'POST', body: form });
    const r = await readLimitedFormData(encoded, 1024);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.form.get('x'), '1');
      assert.equal(await (r.form.get('file') as File).text(), 'hello');
    }
  });

  it('the limit is exact: maxBytes passes, maxBytes + 1 is refused', async () => {
    const form = new FormData();
    form.append('x', 'y'.repeat(100));
    const size = (await new Request('http://localhost/', { method: 'POST', body: form }).arrayBuffer()).byteLength;
    const mk = () => new Request('http://localhost/', { method: 'POST', body: form });
    // Drop the declared length so only the streaming count applies.
    const strip = (req: Request) =>
      streamedRequest(req.body!, req.headers.get('content-type')!.split('boundary=')[1]);
    assert.equal((await readLimitedFormData(strip(mk()), size)).ok, true);
    assert.deepEqual(await readLimitedFormData(strip(mk()), size - 1), { ok: false, reason: 'too_large' });
  });

  it('a malformed body is invalid, not too large', async () => {
    const r = await readLimitedFormData(
      new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'nope' }),
      1024,
    );
    assert.deepEqual(r, { ok: false, reason: 'invalid' });
    const empty = await readLimitedFormData(new Request('http://localhost/', { method: 'POST' }), 1024);
    assert.deepEqual(empty, { ok: false, reason: 'invalid' });
  });
});
