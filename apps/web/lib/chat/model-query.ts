import type { NextRequest } from 'next/server';

/** Optional chat model override from query string or JSON body. */
export function chatModelIdFromSearch(req: NextRequest): string | undefined {
  const value = req.nextUrl.searchParams.get('modelId')?.trim();
  return value || undefined;
}

export function withChatModelQuery(url: string, modelId?: string | null): string {
  if (!modelId?.trim()) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}modelId=${encodeURIComponent(modelId.trim())}`;
}
