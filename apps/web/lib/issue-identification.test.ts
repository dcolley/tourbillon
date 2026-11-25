import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isIssueIdentifier,
  isIssueUuid,
  pickIssueCandidate,
} from './issue-identification';

const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const GUID_UPPER = GUID.toUpperCase();

describe('issue URL param detection (#286)', () => {
  it('accepts uuid guid, including mixed case', () => {
    assert.equal(isIssueUuid(GUID), true);
    assert.equal(isIssueUuid(GUID_UPPER), true);
  });

  it('rejects identifiers and garbage as uuid', () => {
    assert.equal(isIssueUuid('TOUR-590'), false);
    assert.equal(isIssueUuid('tour-590'), false);
    assert.equal(isIssueUuid('TOUR-abc'), false);
    assert.equal(isIssueUuid(GUID.slice(0, -1)), false);
  });

  it('accepts human identifiers', () => {
    assert.equal(isIssueIdentifier('TOUR-590'), true);
    assert.equal(isIssueIdentifier('ACME-1'), true);
  });

  it('rejects uuid, garbage, and malformed identifiers', () => {
    assert.equal(isIssueIdentifier(GUID), false);
    assert.equal(isIssueIdentifier('nonsense'), false);
    assert.equal(isIssueIdentifier('TOUR-'), false);
    assert.equal(isIssueIdentifier('TOUR-590x'), false);
    assert.equal(isIssueIdentifier('tour-590'), false);
  });
});

describe('pickIssueCandidate (#286 cross-company collisions)', () => {
  const row = (id: string, companyId: string, createdAt: Date) => ({
    id,
    companyId,
    createdAt,
  });

  it('returns null for no candidates', () => {
    assert.equal(pickIssueCandidate([]), null);
  });

  it('prefers the active company on collision', () => {
    const a = row('a', 'co-1', new Date('2026-01-01'));
    const b = row('b', 'co-2', new Date('2026-01-02'));
    assert.equal(pickIssueCandidate([a, b], 'co-2')?.id, 'b');
    assert.equal(pickIssueCandidate([b, a], 'co-2')?.id, 'b');
  });

  it('falls back deterministically when active company has no match', () => {
    const old = row('old', 'co-1', new Date('2026-01-01'));
    const newer = row('new', 'co-2', new Date('2026-02-01'));
    assert.equal(pickIssueCandidate([newer, old], 'co-3')?.id, 'old');
    // Same input in a different array order yields the same pick.
    assert.equal(pickIssueCandidate([old, newer], 'co-3')?.id, 'old');
  });

  it('breaks createdAt ties by id, so the pick is stable', () => {
    const t = new Date('2026-01-01');
    const a = row('aaa', 'co-1', t);
    const b = row('bbb', 'co-2', t);
    assert.equal(pickIssueCandidate([b, a])?.id, 'aaa');
  });

  it('handles candidates without createdAt', () => {
    const a = { id: 'a', companyId: 'co-1' };
    const b = { id: 'b', companyId: 'co-2' };
    assert.equal(pickIssueCandidate([b, a])?.id, 'a');
  });

  it('returns the single candidate', () => {
    const only = row('x', 'co-9', new Date('2026-01-01'));
    assert.equal(pickIssueCandidate([only], 'co-1')?.id, 'x');
    assert.equal(pickIssueCandidate([only])?.id, 'x');
  });
});
