/**
 * Reads a multipart (or urlencoded) request body with a hard byte cap, for upload routes.
 *
 * - A declared Content-Length over the cap is refused before anything is read.
 * - Otherwise (no length, chunked, or a length that understates the body) the body is counted
 *   while it streams and the read is aborted as soon as it passes the cap: at most `maxBytes`
 *   (plus one chunk) is ever held, never the full body.
 */
export type LimitedFormResult =
  | { ok: true; form: FormData }
  | { ok: false; reason: 'too_large' | 'invalid' };

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = 'BodyTooLargeError';
  }
}

/** Passes bytes through and errors (cancelling the source) once more than `maxBytes` have passed. */
export function byteLimitStream(maxBytes: number, onExceeded?: () => void): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        onExceeded?.();
        controller.error(new BodyTooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export async function readLimitedFormData(req: Request, maxBytes: number): Promise<LimitedFormResult> {
  const declared = req.headers.get('content-length');
  if (declared !== null && declared.trim() !== '') {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, reason: 'too_large' };
  }
  if (!req.body) return { ok: false, reason: 'invalid' };

  let exceeded = false;
  const limited = req.body.pipeThrough(byteLimitStream(maxBytes, () => (exceeded = true)));
  const headers = new Headers(req.headers);
  headers.delete('content-length');
  const counted = new Request('http://upload.local/', {
    method: 'POST',
    headers,
    body: limited,
    // Required by undici for a streamed request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  try {
    return { ok: true, form: await counted.formData() };
  } catch {
    return { ok: false, reason: exceeded ? 'too_large' : 'invalid' };
  }
}
