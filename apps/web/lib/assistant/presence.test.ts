/**
 * AGENT-AVATAR-UI: the two dots are independent — activity on the avatar (green/yellow/none),
 * unread on the row (blue/none) — and both can show at once. No stacked priority between them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentHasUnread,
  avatarActivityDot,
  listUnreadDot,
  type AgentActivitySignals,
} from './presence';

const signals = (running: boolean, waiting: boolean): AgentActivitySignals => ({ running, waiting });

describe('AGENT-AVATAR-UI avatar activity dot (activity only)', () => {
  it('green when working, yellow when waiting, nothing when idle', () => {
    assert.equal(avatarActivityDot(signals(true, false)), 'working');
    assert.equal(avatarActivityDot(signals(false, true)), 'waiting');
    assert.equal(avatarActivityDot(signals(false, false)), null);
  });

  it('a run in flight wins over waiting inside the activity dot (one avatar, one colour)', () => {
    assert.equal(avatarActivityDot(signals(true, true)), 'working');
  });

  it('unread never reaches the avatar dot: no unread flag can change an activity answer', () => {
    // S297-S2 (Refs #297): behavioural pin replaces the old toString() source regex — the mapper
    // takes exactly one argument (no unread input at all) AND its answer stays identical when a
    // caller smuggles an `unread` flag onto the signals object. The sidebar-row test in
    // components/assistant/sidebar.test.ts pins the same rule end-to-end (idle + unread shows
    // only the blue row dot, never an avatar dot).
    assert.equal(avatarActivityDot.length, 1);
    const cases: Array<[boolean, boolean, 'working' | 'waiting' | null]> = [
      [true, false, 'working'],
      [false, true, 'waiting'],
      [true, true, 'working'],
      [false, false, null],
    ];
    for (const [running, waiting, expected] of cases) {
      const withoutUnread: AgentActivitySignals = { running, waiting };
      // Untyped copy with an extra `unread` flag — the shape a buggy caller could post.
      const withUnread = { ...withoutUnread, unread: true };
      assert.equal(avatarActivityDot(withoutUnread), expected, `running=${running} waiting=${waiting}`);
      assert.equal(avatarActivityDot(withUnread), expected, `unread must not move the avatar dot (running=${running} waiting=${waiting})`);
    }
  });
});

describe('AGENT-AVATAR-UI row unread dot (unread only)', () => {
  it('blue when unread, nothing when none unread', () => {
    assert.equal(listUnreadDot(true), 'unread');
    assert.equal(listUnreadDot(false), null);
  });

  it('agentHasUnread: any unread thread marks the agent, empty/undefined does not', () => {
    assert.equal(agentHasUnread([{ unread: false }, { unread: true }]), true);
    assert.equal(agentHasUnread([{ unread: false }]), false);
    assert.equal(agentHasUnread([]), false);
    assert.equal(agentHasUnread(undefined), false);
  });
});

describe('AGENT-AVATAR-UI two dots are independent (no stacked priority)', () => {
  it('working + unread: green on the avatar AND blue on the row at the same time', () => {
    assert.equal(avatarActivityDot(signals(true, false)), 'working');
    assert.equal(listUnreadDot(true), 'unread');
  });

  it('waiting + unread: yellow on the avatar AND blue on the row', () => {
    assert.equal(avatarActivityDot(signals(false, true)), 'waiting');
    assert.equal(listUnreadDot(true), 'unread');
  });

  it('idle + unread: no avatar dot, blue row dot (unread never lands on the avatar)', () => {
    assert.equal(avatarActivityDot(signals(false, false)), null);
    assert.equal(listUnreadDot(true), 'unread');
  });

  it('working + read: avatar dot only, no row dot', () => {
    assert.equal(avatarActivityDot(signals(true, false)), 'working');
    assert.equal(listUnreadDot(false), null);
  });

  it('idle + read: no dots at all', () => {
    assert.equal(avatarActivityDot(signals(false, false)), null);
    assert.equal(listUnreadDot(false), null);
  });

  it('activity never changes with unread, and unread never changes with activity', () => {
    for (const s of [signals(true, false), signals(false, true), signals(false, false)]) {
      const dot = avatarActivityDot(s);
      assert.equal(avatarActivityDot(s), dot); // stable against a separate unread flag
      listUnreadDot(true);
      assert.equal(avatarActivityDot(s), dot);
    }
    assert.equal(listUnreadDot(true), 'unread');
  });
});
