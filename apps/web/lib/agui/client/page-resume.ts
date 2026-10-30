/**
 * STREAM-1: tells the agent chat when the page comes back after its run stream may have been lost.
 *
 * iPad Safari (and other mobile browsers) suspend a backgrounded tab and its fetches; on return the
 * chat must catch up (reload the thread's messages, re-attach to a run that is still going). Fires on:
 * - `visibilitychange` to visible, after the page was hidden at least `minHiddenMs` (a quick tab flick
 *   on desktop keeps its stream); the away time is counted from `visibilitychange` to hidden or from
 *   `pagehide` (Safari may freeze a tab on app switch without ever reporting `hidden`);
 * - `pageshow` restored from the back/forward cache (`persisted`);
 * - `online`.
 * No React here; components/assistant/use-agent-chat.ts binds it to the chat client.
 */

export type PageResumeReason = 'visible' | 'pageshow' | 'online';

interface EventTargetLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface WatchPageResumeOptions {
  /** Defaults to the global `document` / `window` (no-op when there is none, e.g. on the server). */
  document?: EventTargetLike & { visibilityState?: string };
  window?: EventTargetLike;
  /** Shortest hidden time that counts as "away" for `visibilitychange`. */
  minHiddenMs?: number;
  now?: () => number;
}

export const PAGE_RESUME_MIN_HIDDEN_MS = 1000;

/** Calls `onResume` each time the page comes back; returns the unsubscribe. */
export function watchPageResume(
  onResume: (reason: PageResumeReason) => void,
  opts: WatchPageResumeOptions = {},
): () => void {
  const g = globalThis as { document?: WatchPageResumeOptions['document']; window?: EventTargetLike };
  const doc = opts.document ?? g.document;
  const win = opts.window ?? g.window;
  const minHiddenMs = opts.minHiddenMs ?? PAGE_RESUME_MIN_HIDDEN_MS;
  const now = opts.now ?? (() => Date.now());
  let hiddenAt: number | null = doc?.visibilityState === 'hidden' ? now() : null;

  const fire = (reason: PageResumeReason) => {
    try {
      onResume(reason);
    } catch {
      /* a listener must not break the page */
    }
  };
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') {
      hiddenAt = now();
      return;
    }
    if (doc?.visibilityState !== 'visible' || hiddenAt === null) return;
    const away = now() - hiddenAt;
    hiddenAt = null;
    if (away >= minHiddenMs) fire('visible');
  };
  // CHAT-RECONNECT: iPad Safari can freeze a tab on app switch without a `hidden` visibilitychange;
  // `pagehide` (bfcache suspend) marks the same away state so the return still counts as a resume.
  const onPageHide = () => {
    if (hiddenAt === null) hiddenAt = now();
  };
  const onPageShow = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted) fire('pageshow');
  };
  const onOnline = () => fire('online');

  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('pageshow', onPageShow);
  win?.addEventListener('online', onOnline);
  return () => {
    doc?.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('pageshow', onPageShow);
    win?.removeEventListener('online', onOnline);
  };
}
