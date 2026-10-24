/**
 * CHAT-1: default uploader for composer attachments → POST /api/agui/{agentId}/attachments.
 */
import type { ChatAttachmentRef } from '@/lib/chat-attachments';
import type { UploadAttachment } from './composer-controller';

export function attachmentUploadUrl(agentId: string): string {
  return `/api/agui/${encodeURIComponent(agentId)}/attachments`;
}

export function createAttachmentUploader(
  agentId: string,
  threadId?: string | null,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): UploadAttachment {
  return async (file, { signal }) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (threadId) form.append('threadId', threadId);
    const res = await fetchImpl(attachmentUploadUrl(agentId), { method: 'POST', body: form, signal });
    const body = (await res.json().catch(() => null)) as (Partial<ChatAttachmentRef> & { error?: string }) | null;
    if (!res.ok || !body || typeof body.path !== 'string') {
      throw new Error(body?.error || `upload failed (${res.status})`);
    }
    return {
      path: body.path,
      name: typeof body.name === 'string' ? body.name : file.name,
      size: typeof body.size === 'number' ? body.size : file.size,
      mediaType: typeof body.mediaType === 'string' ? body.mediaType : file.type,
    };
  };
}
