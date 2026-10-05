import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectThreadToBind } from './thread-selection';
import type { ChatThreadInfo } from './use-agent-chat-session';

describe('selectThreadToBind', () => {
  it('returns null when no threads provided', () => {
    const result = selectThreadToBind([]);
    assert.strictEqual(result, null, 'Should return null for empty thread list');
  });

  it('returns null when only shared threads exist (no own threads)', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-shared-1',
        title: 'Shared thread 1',
        isOwn: false,
        isShared: true,
      },
      {
        id: 'thread-shared-2',
        title: 'Shared thread 2',
        isOwn: false,
        isShared: true,
      },
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      null,
      'Should return null when only shared threads exist (never auto-bind shared)',
    );
  });

  it('returns first own thread when own threads exist', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'thread-own-2',
        title: 'Own thread 2',
        isOwn: true,
        isShared: false,
      },
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      'thread-own-1',
      'Should return first own thread (newest)',
    );
  });

  it('ignores shared threads and returns first own thread', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'thread-shared-1',
        title: 'Shared thread 1',
        isOwn: false,
        isShared: true,
      },
      {
        id: 'thread-own-2',
        title: 'Own thread 2',
        isOwn: true,
        isShared: false,
      },
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      'thread-own-1',
      'Should return first own thread, ignoring shared threads',
    );
  });

  it('returns preferred thread ID if it is an own thread', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'thread-own-2',
        title: 'Own thread 2',
        isOwn: true,
        isShared: false,
      },
    ];

    const result = selectThreadToBind(threads, 'thread-own-2');
    assert.strictEqual(
      result,
      'thread-own-2',
      'Should return preferred thread ID if it is an own thread',
    );
  });

  it('ignores preferred thread ID if it is a shared thread', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'thread-shared-1',
        title: 'Shared thread 1',
        isOwn: false,
        isShared: true,
      },
    ];

    const result = selectThreadToBind(threads, 'thread-shared-1');
    assert.strictEqual(
      result,
      'thread-own-1',
      'Should ignore preferred thread ID if it is a shared thread and return first own thread',
    );
  });

  it('returns first own thread when preferred thread ID not found', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'thread-own-2',
        title: 'Own thread 2',
        isOwn: true,
        isShared: false,
      },
    ];

    const result = selectThreadToBind(threads, 'thread-nonexistent');
    assert.strictEqual(
      result,
      'thread-own-1',
      'Should return first own thread when preferred thread ID not found',
    );
  });

  it('handles threads without isOwn/isShared flags (treats as not own)', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-1',
        title: 'Thread 1',
        // No isOwn/isShared flags
      },
      {
        id: 'thread-own-1',
        title: 'Own thread 1',
        isOwn: true,
        isShared: false,
      },
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      'thread-own-1',
      'Should skip threads without isOwn flag and return first thread with isOwn: true',
    );
  });

  it('returns null when all threads lack isOwn flag', () => {
    const threads: ChatThreadInfo[] = [
      {
        id: 'thread-1',
        title: 'Thread 1',
        // No isOwn flag
      },
      {
        id: 'thread-2',
        title: 'Thread 2',
        // No isOwn flag
      },
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      null,
      'Should return null when all threads lack isOwn flag (treated as not own)',
    );
  });

  it('matches real-world scenario: COO with 0 own threads + 73 shared threads', () => {
    // Simulate TEST Demo: COO has no own threads, 73 untagged shared threads
    const threads: ChatThreadInfo[] = Array.from({ length: 73 }, (_, i) => ({
      id: `shared-thread-${i + 1}`,
      title: `Untagged thread ${i + 1}`,
      isOwn: false,
      isShared: true,
    }));

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      null,
      'Should return null for COO with 0 own threads (never auto-bind shared threads)',
    );
  });

  it('matches real-world scenario: CEO with 2 own threads + 73 shared threads', () => {
    // Simulate TEST Demo: CEO has 2 own threads + 73 shared threads
    const threads: ChatThreadInfo[] = [
      {
        id: 'ceo-thread-1',
        title: 'CEO thread 1',
        isOwn: true,
        isShared: false,
      },
      {
        id: 'ceo-thread-2',
        title: 'CEO thread 2',
        isOwn: true,
        isShared: false,
      },
      ...Array.from({ length: 73 }, (_, i) => ({
        id: `shared-thread-${i + 1}`,
        title: `Untagged thread ${i + 1}`,
        isOwn: false,
        isShared: true,
      })),
    ];

    const result = selectThreadToBind(threads);
    assert.strictEqual(
      result,
      'ceo-thread-1',
      'Should return first own thread (CEO thread 1), ignoring 73 shared threads',
    );
  });
});
