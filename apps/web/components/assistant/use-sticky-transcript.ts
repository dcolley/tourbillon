'use client';

/**
 * CHAT-PAGE-1: React binding for the transcript's sticky-bottom scrolling (rules in
 * lib/assistant/transcript-scroll.ts). Attach `ref` and `onScroll` to the scrolling message list.
 *
 * - First render with the chat ready: scrolled to the bottom, pinned.
 * - Any content change (a new message, streamed text, a tool card) while pinned: kept at the bottom.
 * - The user scrolls away from the bottom: unpinned until they scroll back down, send (`pin`), or use
 *   Jump to latest (`pin`).
 * - `beforePrepend()` (call right before "Load previous") anchors the first message on screen; when the
 *   older messages render, the scroll position is moved by their height so the view does not jump.
 */
import { useCallback, useLayoutEffect, useEffect, useRef, useState } from 'react';
import {
  bottomScrollTop,
  nextPinned,
  scrollTopAfterContentChange,
  scrollTopForAnchor,
  type ScrollMetrics,
  type StickEvent,
} from '@/lib/assistant/transcript-scroll';

/** Each transcript item's root element carries `data-item` (agent-chat.tsx ItemView). */
const ITEM_SELECTOR = '[data-item]';

// useLayoutEffect warns during server rendering; the view is also rendered with react-dom/server in tests.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

interface Anchor {
  el: Element;
  /** Anchor offsetTop − scrollTop before the prepend. */
  offset: number;
}

const metricsOf = (el: HTMLElement): ScrollMetrics => ({
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
});

const topOf = (el: Element) => (el as HTMLElement).offsetTop ?? 0;

export interface StickyTranscript {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** False once the user has scrolled up away from the newest content. */
  pinned: boolean;
  /** Re-pin and scroll to the bottom (send, Jump to latest). */
  pin: (reason?: 'send' | 'jump') => void;
  /** Call right before loading older messages so the view keeps its place when they are prepended. */
  beforePrepend: () => void;
  /** Call when a load of older messages ended (anchor released if nothing was prepended). */
  afterPrepend: () => void;
}

/**
 * @param content changes whenever the transcript's rendered content may have changed (items array,
 *   pending tools); compared by identity.
 * @param ready the chat is open and showing its first page.
 */
export function useStickyTranscript(content: readonly unknown[], ready: boolean): StickyTranscript {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinnedState] = useState(true);
  const anchor = useRef<Anchor | null>(null);
  const opened = useRef(false);

  const apply = useCallback((event: StickEvent) => {
    const next = nextPinned(pinnedRef.current, event);
    pinnedRef.current = next;
    setPinnedState(next);
  }, []);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!ready) {
      // Reconnecting / a new thread (Clear chat): the next ready render opens at the bottom again.
      opened.current = false;
      anchor.current = null;
      return;
    }
    if (!el) return;
    const a = anchor.current;
    if (a) {
      if (!a.el.isConnected) {
        anchor.current = null;
      } else {
        const target = scrollTopForAnchor(topOf(a.el), a.offset);
        if (target !== el.scrollTop) el.scrollTop = target;
        // Keep the anchor until the older rows arrive (the first item changes); streamed content
        // meanwhile renders below and does not move the anchored view.
        if (el.querySelector(ITEM_SELECTOR) !== a.el) anchor.current = null;
        return;
      }
    }
    if (!opened.current) {
      opened.current = true;
      apply({ type: 'open' });
      el.scrollTop = bottomScrollTop(metricsOf(el));
      return;
    }
    const target = scrollTopAfterContentChange(pinnedRef.current, metricsOf(el));
    if (target !== null && target !== el.scrollTop) el.scrollTop = target;
  }, [ready, ...content]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el || anchor.current) return;
    apply({ type: 'scroll', metrics: metricsOf(el) });
  }, [apply]);

  const pin = useCallback(
    (reason: 'send' | 'jump' = 'jump') => {
      anchor.current = null;
      apply({ type: reason });
      const el = ref.current;
      if (el) el.scrollTop = bottomScrollTop(metricsOf(el));
    },
    [apply],
  );

  const beforePrepend = useCallback(() => {
    const el = ref.current;
    const first = el?.querySelector(ITEM_SELECTOR);
    if (!el || !first) return;
    anchor.current = { el: first, offset: topOf(first) - el.scrollTop };
  }, []);

  const afterPrepend = useCallback(() => {
    // Let the render that shows the older rows (if any) apply the anchor first.
    const release = () => {
      anchor.current = null;
      const el = ref.current;
      if (el) apply({ type: 'scroll', metrics: metricsOf(el) });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(release);
    else release();
  }, [apply]);

  return { ref, onScroll, pinned, pin, beforePrepend, afterPrepend };
}
