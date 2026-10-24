/**
 * CHAT-1: composer drafts saved per agent thread in localStorage, so a draft survives reload.
 *
 * Key `tourbillon.composer.draft:{agentId}:{threadId|new}`; value `{ v: 1, text, attachments,
 * updatedAt }` (attachments are the already-uploaded workspace refs). Bounded: text is cut at
 * MAX_DRAFT_CHARS and at most MAX_DRAFTS drafts are kept (oldest dropped). Storage failures (quota,
 * private mode, no window) are ignored: a draft is a convenience, never a reason to fail.
 */
import type { ChatAttachmentRef } from '@/lib/chat-attachments';

export const DRAFT_KEY_PREFIX = 'tourbillon.composer.draft:';
export const MAX_DRAFT_CHARS = 50_000;
export const MAX_DRAFTS = 50;

export interface ComposerDraft {
  text: string;
  attachments: ChatAttachmentRef[];
  updatedAt: number;
}

/** The subset of the Web Storage API used here. */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function draftKey(agentId: string, threadId?: string | null): string {
  return `${DRAFT_KEY_PREFIX}${agentId}:${threadId || 'new'}`;
}

function browserStorage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isRef(value: unknown): value is ChatAttachmentRef {
  const v = value as ChatAttachmentRef | null;
  return (
    !!v &&
    typeof v.path === 'string' &&
    typeof v.name === 'string' &&
    typeof v.mediaType === 'string' &&
    typeof v.size === 'number'
  );
}

function parse(raw: string | null): ComposerDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { v?: unknown; text?: unknown; attachments?: unknown; updatedAt?: unknown };
    if (v?.v !== 1 || typeof v.text !== 'string') return null;
    return {
      text: v.text.slice(0, MAX_DRAFT_CHARS),
      attachments: Array.isArray(v.attachments) ? v.attachments.filter(isRef).slice(0, 20) : [],
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export interface DraftStore {
  load(key: string): ComposerDraft | null;
  /** Saves, or removes the draft when there is nothing in it. */
  save(key: string, draft: { text: string; attachments: readonly ChatAttachmentRef[] }): void;
  clear(key: string): void;
}

export function createDraftStore(
  storage: DraftStorage | null = browserStorage(),
  now: () => number = Date.now,
): DraftStore {
  const prune = () => {
    if (!storage) return;
    const drafts: Array<{ key: string; updatedAt: number }> = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(DRAFT_KEY_PREFIX)) continue;
      drafts.push({ key, updatedAt: parse(storage.getItem(key))?.updatedAt ?? 0 });
    }
    if (drafts.length <= MAX_DRAFTS) return;
    drafts.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const d of drafts.slice(0, drafts.length - MAX_DRAFTS)) storage.removeItem(d.key);
  };
  return {
    load(key) {
      try {
        return parse(storage?.getItem(key) ?? null);
      } catch {
        return null;
      }
    },
    save(key, draft) {
      if (!storage) return;
      try {
        if (!draft.text.trim() && draft.attachments.length === 0) {
          storage.removeItem(key);
          return;
        }
        storage.setItem(
          key,
          JSON.stringify({
            v: 1,
            text: draft.text.slice(0, MAX_DRAFT_CHARS),
            attachments: draft.attachments,
            updatedAt: now(),
          }),
        );
        prune();
      } catch {
        /* quota or private mode: keep working without a saved draft */
      }
    },
    clear(key) {
      try {
        storage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
