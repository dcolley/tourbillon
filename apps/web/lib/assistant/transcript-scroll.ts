/**
 * CHAT-PAGE-1: sticky-bottom scrolling for the assistant transcript (pure rules; the React binding is
 * components/assistant/use-sticky-transcript.ts).
 *
 * - The transcript opens scrolled to the bottom and stays pinned there while content streams in.
 * - Scrolling up (away from the bottom) unpins it: new content no longer moves the view.
 * - It pins again when the user scrolls back to the bottom, sends a message, or uses "Jump to latest".
 * - "Load previous" prepends older messages without moving what is on screen: the first message shown
 *   before the load keeps its position in the viewport.
 */

/** Within this many px of the bottom counts as "at the bottom" (sub-pixel rounding, small nudges). */
export const TRANSCRIPT_STICK_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export function isAtBottom(m: ScrollMetrics, threshold = TRANSCRIPT_STICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/** The scrollTop that shows the bottom of the content. */
export function bottomScrollTop(m: Pick<ScrollMetrics, 'scrollHeight' | 'clientHeight'>): number {
  return Math.max(0, m.scrollHeight - m.clientHeight);
}

export type StickEvent =
  /** The transcript opened (first render with content) or the user re-pinned (Jump to latest). */
  | { type: 'open' }
  | { type: 'jump' }
  /** The user sent a message (send / follow-up / steer). */
  | { type: 'send' }
  /** A scroll event, with the scroller's metrics after it. */
  | { type: 'scroll'; metrics: ScrollMetrics };

/** Whether the transcript is pinned to the bottom after an event. */
export function nextPinned(pinned: boolean, event: StickEvent): boolean {
  switch (event.type) {
    case 'open':
    case 'jump':
    case 'send':
      return true;
    case 'scroll':
      // At the bottom (including after an automatic scroll there): pinned. Anywhere else: the user
      // has scrolled away, so new content must not pull the view down.
      return isAtBottom(event.metrics);
  }
}

/**
 * After older messages were prepended: the scrollTop that keeps the anchor (the first message shown
 * before the load) where it was in the viewport. `anchorOffset` is the anchor's offsetTop minus
 * scrollTop, measured before the load; `anchorTopAfter` its offsetTop after the new rows rendered.
 */
export function scrollTopForAnchor(anchorTopAfter: number, anchorOffset: number): number {
  return Math.max(0, anchorTopAfter - anchorOffset);
}

/** Content changed: the scrollTop to apply, or null to leave the view where it is. */
export function scrollTopAfterContentChange(pinned: boolean, m: ScrollMetrics): number | null {
  return pinned ? bottomScrollTop(m) : null;
}
