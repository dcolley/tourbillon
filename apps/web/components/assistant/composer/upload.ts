/**
 * CHAT-1: default uploader for composer attachments → POST /api/agui/{agentId}/attachments.
 */
import type { ChatAttachmentRef } from '@/lib/chat-attachments';
import type { UploadAttachment } from './composer-controller';

export function attachmentUploadUrl(agentId: string, threadId?: string | null): string {
  const base = `/api/agui/${encodeURIComponent(agentId)}/attachments`;
  return threadId ? `${base}?threadId=${encodeURIComponent(threadId)}` : base;
}

export function createAttachmentUploader(
  agentId: string,
  threadId?: string | null,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): UploadAttachment {
  return async (file, { signal }) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetchImpl(attachmentUploadUrl(agentId, threadId), { method: 'POST', body: form, signal });
    const body = (await res.json().catch(() => null)) as (Partial<ChatAttachmentRef> & { error?: string }) | null;
    if (!res.ok || !body || typeof body.path !== 'string') {
      throw new Error(body?.error || `upload failed (${res.status})`);
    }
    return {
      path: body.path,
      name: typeof body.name === 'string' ? body.name : file.name,
      size: typeof body.size === 'number' ? body.size : file.size,
      // The server decides the media type (from its allow-list), not the browser.
      mediaType: typeof body.mediaType === 'string' ? body.mediaType : 'application/octet-stream',
    };
  };
}
