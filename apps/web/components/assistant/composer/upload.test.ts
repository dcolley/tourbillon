/** CHAT-1 hardening: the composer uploader sends threadId in the query and keeps the server's media type. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentUploadUrl, createAttachmentUploader } from './upload';

function fakeFetch(response: unknown, status = 201) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

describe('CHAT-1 composer uploader', () => {
  it('puts the thread in the query string, encoded', async () => {
    assert.equal(attachmentUploadUrl('a b'), '/api/agui/a%20b/attachments');
    assert.equal(attachmentUploadUrl('alice', 't:1/x'), '/api/agui/alice/attachments?threadId=t%3A1%2Fx');
    assert.equal(attachmentUploadUrl('alice', null), '/api/agui/alice/attachments');
    const { impl, calls } = fakeFetch({ path: 'p', name: 'a.png', size: 3, mediaType: 'image/png' });
    await createAttachmentUploader('alice', 'thread-1', impl)(new File(['abc'], 'a.png'), { signal: new AbortController().signal });
    assert.equal(calls[0].url, '/api/agui/alice/attachments?threadId=thread-1');
    const body = calls[0].init?.body as FormData;
    assert.equal(body.has('threadId'), false);
    assert.equal((body.get('file') as File).name, 'a.png');
  });

  it('uses the media type the server returns, never the browser type', async () => {
    const file = new File(['abc'], 'a.png', { type: 'text/html' });
    const signal = new AbortController().signal;
    const fromServer = await createAttachmentUploader('alice', null, fakeFetch({ path: 'p', mediaType: 'image/png' }).impl)(file, { signal });
    assert.equal(fromServer.mediaType, 'image/png');
    const missing = await createAttachmentUploader('alice', null, fakeFetch({ path: 'p' }).impl)(file, { signal });
    assert.equal(missing.mediaType, 'application/octet-stream');
  });

  it('surfaces the server error message', async () => {
    const up = createAttachmentUploader('alice', null, fakeFetch({ error: 'a.exe: no' }, 400).impl);
    await assert.rejects(up(new File(['x'], 'a.exe'), { signal: new AbortController().signal }), /a\.exe: no/);
  });
});
