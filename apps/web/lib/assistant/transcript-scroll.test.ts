/**
 * CHAT-PAGE-1: sticky-bottom transcript scrolling rules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bottomScrollTop,
  distanceFromBottom,
  isAtBottom,
  nextPinned,
  scrollTopAfterContentChange,
  scrollTopForAnchor,
  TRANSCRIPT_STICK_THRESHOLD_PX,
} from './transcript-scroll';

const m = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

describe('transcript sticky scroll', () => {
  it('bottom detection with a small threshold', () => {
    assert.equal(distanceFromBottom(m(1500)), 0);
    assert.equal(isAtBottom(m(1500)), true);
    assert.equal(isAtBottom(m(1500 - TRANSCRIPT_STICK_THRESHOLD_PX)), true);
    assert.equal(isAtBottom(m(1500 - TRANSCRIPT_STICK_THRESHOLD_PX - 1)), false);
    assert.equal(isAtBottom(m(0, 300, 500)), true, 'content shorter than the viewport is at the bottom');
    assert.equal(bottomScrollTop(m(0)), 1500);
    assert.equal(bottomScrollTop(m(0, 300, 500)), 0);
  });

  it('opens pinned; scrolling up unpins; scrolling back down re-pins', () => {
    let pinned = nextPinned(false, { type: 'open' });
    assert.equal(pinned, true);
    pinned = nextPinned(pinned, { type: 'scroll', metrics: m(1500) });
    assert.equal(pinned, true, 'automatic scroll to the bottom keeps it pinned');
    pinned = nextPinned(pinned, { type: 'scroll', metrics: m(900) });
    assert.equal(pinned, false, 'user scrolled up');
    pinned = nextPinned(pinned, { type: 'scroll', metrics: m(1490) });
    assert.equal(pinned, true, 'natural re-engage at the bottom');
  });

  it('send and Jump to latest re-pin', () => {
    assert.equal(nextPinned(false, { type: 'send' }), true);
    assert.equal(nextPinned(false, { type: 'jump' }), true);
  });

  it('streamed content follows the bottom only while pinned', () => {
    // Content grew by 300px (a streamed chunk): pinned → new bottom; unpinned → stay.
    assert.equal(scrollTopAfterContentChange(true, m(1500, 2300)), 1800);
    assert.equal(scrollTopAfterContentChange(false, m(400, 2300)), null);
  });

  it('prepending older messages keeps the anchor in place (no jump)', () => {
    // Anchor (first message shown) was 12px below the top of the viewport at scrollTop 0 (offsetTop 28).
    const offset = 28 - 0;
    // 20 older messages rendered above it: its offsetTop is now 1628.
    assert.equal(scrollTopForAnchor(1628, offset), 1600);
    assert.equal(scrollTopForAnchor(10, 28), 0, 'never negative');
  });
});
