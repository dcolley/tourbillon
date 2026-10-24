/**
 * CHAT-1: composer state and behaviour, framework-free (the React view in composer.tsx subscribes
 * with useSyncExternalStore). Tested directly, without a DOM.
 *
 * - Text: multiline; Enter sends, Shift+Enter is a newline, Enter during IME composition is ignored.
 * - Attachments: picker, paste and drag-drop all go through addFiles → checked against
 *   lib/chat-attachments (type, size, count), refused files get a clear notice; accepted files upload
 *   straight away (chip: uploading → ready; a failed upload is removed with a notice). Removing a chip
 *   cancels its upload. Sending waits until every chip is ready.
 * - Run controls: while a run is open (status ≠ idle), the primary action queues a follow-up instead of
 *   sending; Steer (button, or Ctrl/Cmd/Alt+Enter) sends the text to the running agent; Stop ends the
 *   run. Queued follow-ups stay editable and removable; the first is sent when the run ends, the next
 *   when that run ends.
 * - Draft: text and ready attachments are saved per thread (draft-store) and restored on load.
 *
 * Seam for the chat client (AGUI-1b): `controls` (send / steer / stop) and setRunStatus(status). A
 * result `{ ok: false }` from send / steer keeps the text (or puts a queued item back) so nothing the
 * user typed is lost.
 */
import {
  CHAT_ATTACHMENT_MAX_FILES,
  checkChatAttachment,
  messageWithAttachments,
  type ChatAttachmentRef,
} from '@/lib/chat-attachments';
import { createDraftStore, type DraftStore } from './draft-store';
import { editQueued, enqueue, removeQueued, takeNext, type QueuedMessage } from './queue';

export type ComposerRunStatus = 'idle' | 'starting' | 'running' | 'stopping';

export interface ComposerSendResult {
  ok: boolean;
  error?: string;
}

type MaybeResult = Promise<ComposerSendResult | void | undefined> | ComposerSendResult | void | undefined;

/** What the composer needs from the chat client. */
export interface ComposerControls {
  /** Starts a turn with this message. */
  send(text: string): MaybeResult;
  /** Sends this message to the running agent mid-run. */
  steer(text: string): MaybeResult;
  /** Ends the open run. */
  stop(): unknown;
}

export type UploadAttachment = (file: File, options: { signal: AbortSignal }) => Promise<ChatAttachmentRef>;

export type ComposerAttachment =
  | { id: string; status: 'uploading'; name: string; size: number }
  | { id: string; status: 'ready'; name: string; size: number; ref: ChatAttachmentRef };

export interface ComposerNotice {
  kind: 'error' | 'info';
  message: string;
}

export interface ComposerState {
  text: string;
  attachments: ComposerAttachment[];
  queue: QueuedMessage[];
  runStatus: ComposerRunStatus;
  /** A send / steer is in flight. */
  submitting: boolean;
  dragging: boolean;
  notices: ComposerNotice[];
  editing: { id: string; text: string } | null;
}

export type AttachSource = 'picker' | 'paste' | 'drop';

/** Minimal event shapes (React synthetic events satisfy these). */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
}
interface FileListLike {
  readonly length: number;
  [index: number]: File;
}
export interface PasteLike {
  clipboardData: { files?: FileListLike | null } | null;
  preventDefault(): void;
}
export interface DropLike {
  dataTransfer: { files?: FileListLike | null; types?: readonly string[] | null } | null;
  preventDefault(): void;
}

export interface ComposerControllerOptions {
  controls: ComposerControls;
  upload: UploadAttachment;
  /** Draft key (draftKey(agentId, threadId)); no key → no saved draft. */
  draftKey?: string;
  drafts?: DraftStore;
  runStatus?: ComposerRunStatus;
  makeId?: () => string;
}

const MAX_NOTICES = 5;

function toList(files: FileListLike | readonly File[] | null | undefined): File[] {
  if (!files) return [];
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) if (files[i]) out.push(files[i]);
  return out;
}

const PASTE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Pasted screenshots often arrive as "image.png" or without a name; give them a clear one. */
function namePasted(file: File, index: number): File {
  const ext = PASTE_EXT[file.type];
  if (file.name && file.name !== 'image.png' && !/^blob$/i.test(file.name)) return file;
  if (!ext) return file;
  return new File([file], `pasted-image-${index + 1}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

export function createComposerController(options: ComposerControllerOptions) {
  let seq = 0;
  const makeId = options.makeId ?? (() => `c${Date.now().toString(36)}-${++seq}`);
  const drafts = options.drafts ?? createDraftStore();
  const listeners = new Set<() => void>();
  const uploads = new Map<string, AbortController>();
  let dragDepth = 0;
  let controls = options.controls;

  const saved = options.draftKey ? drafts.load(options.draftKey) : null;
  let state: ComposerState = {
    text: saved?.text ?? '',
    attachments: (saved?.attachments ?? []).map((ref) => ({
      id: makeId(),
      status: 'ready' as const,
      name: ref.name,
      size: ref.size,
      ref,
    })),
    queue: [],
    runStatus: options.runStatus ?? 'idle',
    submitting: false,
    dragging: false,
    notices: [],
    editing: null,
  };

  const set = (patch: Partial<ComposerState>, { persist = false } = {}) => {
    state = { ...state, ...patch };
    if (persist && options.draftKey) {
      drafts.save(options.draftKey, { text: state.text, attachments: readyRefs(state.attachments) });
    }
    for (const l of listeners) l();
  };

  const notify = (notices: ComposerNotice[]) => {
    if (notices.length === 0) return;
    set({ notices: [...state.notices, ...notices].slice(-MAX_NOTICES) });
  };

  const readyRefs = (list: readonly ComposerAttachment[]) =>
    list.flatMap((a) => (a.status === 'ready' ? [a.ref] : []));

  const runOpen = () => state.runStatus !== 'idle';

  const hasContent = () => state.text.trim().length > 0 || state.attachments.length > 0;
  const uploading = () => state.attachments.some((a) => a.status === 'uploading');

  /** Can the current text + attachments be sent / queued / steered now? */
  const canSubmit = () => hasContent() && !uploading() && !state.submitting;

  const clearInput = () => {
    set({ text: '', attachments: [] });
    if (options.draftKey) drafts.clear(options.draftKey);
  };

  const failed = (r: ComposerSendResult | void | undefined): r is ComposerSendResult => !!r && r.ok === false;

  async function submitWith(fn: (text: string) => MaybeResult, mode: 'send' | 'steer'): Promise<boolean> {
    if (!canSubmit()) return false;
    const text = state.text;
    const attachments = state.attachments;
    const message = messageWithAttachments(text, readyRefs(attachments));
    // Clear straight away (no double send); restore if the client refuses it.
    set({ submitting: true, text: '', attachments: [] });
    let result: ComposerSendResult | void | undefined;
    try {
      result = await fn(message);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (failed(result)) {
      // Keep anything typed meanwhile in front of what is restored.
      set(
        {
          submitting: false,
          text: state.text ? `${text}\n${state.text}` : text,
          attachments: [...attachments, ...state.attachments],
        },
        { persist: true },
      );
      notify([{ kind: 'error', message: result.error ? `Not sent: ${result.error}` : `Not sent (${mode}). Your message is still here.` }]);
      return false;
    }
    set({ submitting: false });
    if (options.draftKey && !hasContent()) drafts.clear(options.draftKey);
    else if (options.draftKey) drafts.save(options.draftKey, { text: state.text, attachments: readyRefs(state.attachments) });
    return true;
  }

  async function flushQueue(): Promise<void> {
    if (state.submitting) return;
    const { next, rest } = takeNext(state.queue);
    if (!next) return;
    if (state.editing?.id === next.id) set({ editing: null });
    set({ queue: rest, submitting: true });
    let result: ComposerSendResult | void | undefined;
    try {
      result = await controls.send(messageWithAttachments(next.text, next.attachments));
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    set({ submitting: false });
    if (failed(result)) {
      set({ queue: [next, ...state.queue] });
      notify([{ kind: 'error', message: `Queued message not sent${result.error ? `: ${result.error}` : ''}. It is still in the queue.` }]);
    }
  }

  function startUpload(id: string, file: File) {
    const ac = new AbortController();
    uploads.set(id, ac);
    options.upload(file, { signal: ac.signal }).then(
      (ref) => {
        uploads.delete(id);
        if (ac.signal.aborted) return;
        set(
          {
            attachments: state.attachments.map((a) =>
              a.id === id ? { id, status: 'ready' as const, name: ref.name || a.name, size: ref.size, ref } : a,
            ),
          },
          { persist: true },
        );
      },
      (err: unknown) => {
        uploads.delete(id);
        if (ac.signal.aborted) return;
        set({ attachments: state.attachments.filter((a) => a.id !== id) });
        notify([{ kind: 'error', message: `${file.name}: upload failed${err instanceof Error && err.message ? ` — ${err.message}` : ''}.` }]);
      },
    );
  }

  const controller = {
    getState: (): ComposerState => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canSubmit,
    runOpen,

    /** Swaps the chat client's controls (e.g. a new hook instance after re-render). */
    setControls(next: ComposerControls) {
      controls = next;
    },

    setText(text: string) {
      set({ text }, { persist: true });
    },

    /** Checks and uploads files from the picker, a paste or a drop. Returns how many were accepted. */
    addFiles(files: FileListLike | readonly File[], source: AttachSource = 'picker'): number {
      const list = toList(files).map((f, i) => (source === 'paste' ? namePasted(f, i) : f));
      if (list.length === 0) return 0;
      const notices: ComposerNotice[] = [];
      const accepted: Array<{ id: string; file: File }> = [];
      let room = CHAT_ATTACHMENT_MAX_FILES - state.attachments.length;
      for (const file of list) {
        const check = checkChatAttachment(file);
        if (!check.ok) {
          notices.push({ kind: 'error', message: check.message });
          continue;
        }
        if (room <= 0) {
          notices.push({ kind: 'error', message: `${file.name}: at most ${CHAT_ATTACHMENT_MAX_FILES} files per message.` });
          continue;
        }
        room -= 1;
        accepted.push({ id: makeId(), file });
      }
      if (accepted.length > 0) {
        set({
          attachments: [
            ...state.attachments,
            ...accepted.map(({ id, file }) => ({ id, status: 'uploading' as const, name: file.name, size: file.size })),
          ],
        });
        for (const { id, file } of accepted) startUpload(id, file);
      }
      notify(notices);
      return accepted.length;
    },

    removeAttachment(id: string) {
      uploads.get(id)?.abort();
      uploads.delete(id);
      set({ attachments: state.attachments.filter((a) => a.id !== id) }, { persist: true });
    },

    /** Enter / the main button: send when idle, queue a follow-up while a run is open. */
    async primary(): Promise<boolean> {
      if (!runOpen()) return submitWith((t) => controls.send(t), 'send');
      if (!canSubmit()) return false;
      const item: QueuedMessage = { id: makeId(), text: state.text, attachments: readyRefs(state.attachments) };
      const r = enqueue(state.queue, item);
      if (!r.ok) {
        notify([{ kind: 'error', message: r.reason === 'full' ? 'The queue is full; wait for the reply or remove a queued message.' : 'Nothing to queue.' }]);
        return false;
      }
      set({ queue: r.queue });
      clearInput();
      return true;
    },

    /** Sends the text to the running agent (only while a run is open). */
    async steer(): Promise<boolean> {
      if (!runOpen() || state.runStatus === 'stopping') return false;
      return submitWith((t) => controls.steer(t), 'steer');
    },

    stop() {
      if (!runOpen() || state.runStatus === 'stopping') return;
      void controls.stop();
    },

    /** From the chat client: the run status. The end of a run sends the next queued follow-up. */
    setRunStatus(status: ComposerRunStatus) {
      const was = state.runStatus;
      if (was === status) return;
      set({ runStatus: status });
      if (status === 'idle' && was !== 'idle') void flushQueue();
    },

    /** Sends the first queued follow-up now (only when no run is open, e.g. after a failed send). */
    async sendNextQueued(): Promise<void> {
      if (runOpen() || state.submitting) return;
      await flushQueue();
    },

    startEdit(id: string) {
      const item = state.queue.find((q) => q.id === id);
      if (item) set({ editing: { id, text: item.text } });
    },
    setEditText(text: string) {
      if (state.editing) set({ editing: { ...state.editing, text } });
    },
    saveEdit() {
      if (!state.editing) return;
      set({ queue: editQueued(state.queue, state.editing.id, state.editing.text), editing: null });
    },
    cancelEdit() {
      set({ editing: null });
    },
    removeQueued(id: string) {
      set({ queue: removeQueued(state.queue, id), editing: state.editing?.id === id ? null : state.editing });
    },

    dismissNotice(index: number) {
      set({ notices: state.notices.filter((_, i) => i !== index) });
    },

    /** Textarea keydown. Returns true when the key was handled. */
    handleKeyDown(e: KeyLike): boolean {
      if (e.key !== 'Enter' || e.shiftKey) return false;
      if (e.isComposing || e.nativeEvent?.isComposing) return false;
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey || e.altKey) && runOpen()) void controller.steer();
      else void controller.primary();
      return true;
    },

    /** Textarea paste: files become attachments; plain text pastes as usual. */
    handlePaste(e: PasteLike): boolean {
      const files = toList(e.clipboardData?.files ?? null);
      if (files.length === 0) return false;
      e.preventDefault();
      controller.addFiles(files, 'paste');
      return true;
    },

    handleDragEnter(e: DropLike) {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepth += 1;
      if (!state.dragging) set({ dragging: true });
    },
    handleDragOver(e: DropLike) {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    },
    handleDragLeave() {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && state.dragging) set({ dragging: false });
    },
    handleDrop(e: DropLike): number {
      e.preventDefault();
      dragDepth = 0;
      if (state.dragging) set({ dragging: false });
      return controller.addFiles(toList(e.dataTransfer?.files ?? null), 'drop');
    },

    /** Aborts uploads still in flight (their chips are dropped). */
    cancelUploads() {
      if (uploads.size === 0) return;
      const ids = new Set(uploads.keys());
      for (const ac of uploads.values()) ac.abort();
      uploads.clear();
      set({ attachments: state.attachments.filter((a) => !ids.has(a.id)) });
    },
  };
  return controller;
}

export type ComposerController = ReturnType<typeof createComposerController>;
