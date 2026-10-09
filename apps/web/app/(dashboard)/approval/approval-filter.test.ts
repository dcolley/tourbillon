import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_STATUS_FILTERS,
  parseApprovalStatusFilter,
  statusesForApprovalFilter,
  normalizeApprovalSearchQuery,
  approvalSectionsForFilter,
  approvalListHref,
} from './approval-filter';

describe('Approval Filter - status parsing', () => {
  it('defaults to all when missing/blank/unknown', () => {
    assert.strictEqual(parseApprovalStatusFilter(undefined), 'all');
    assert.strictEqual(parseApprovalStatusFilter(''), 'all');
    assert.strictEqual(parseApprovalStatusFilter('nonsense'), 'all');
  });

  it('accepts every declared filter id', () => {
    for (const f of APPROVAL_STATUS_FILTERS) {
      assert.strictEqual(parseApprovalStatusFilter(f.id), f.id);
    }
  });
});

describe('Approval Filter - status → DB statuses', () => {
  it('all returns null (no status predicate)', () => {
    assert.strictEqual(statusesForApprovalFilter('all'), null);
  });

  it('awaiting and pending map to pending only', () => {
    assert.deepStrictEqual(statusesForApprovalFilter('awaiting'), ['pending']);
    assert.deepStrictEqual(statusesForApprovalFilter('pending'), ['pending']);
  });

  it('decided maps to approved ∪ rejected', () => {
    assert.deepStrictEqual(statusesForApprovalFilter('decided'), ['approved', 'rejected']);
  });

  it('single concrete statuses pass through', () => {
    assert.deepStrictEqual(statusesForApprovalFilter('approved'), ['approved']);
    assert.deepStrictEqual(statusesForApprovalFilter('rejected'), ['rejected']);
  });
});

describe('Approval Filter - query normalisation', () => {
  it('trims and collapses whitespace', () => {
    assert.strictEqual(normalizeApprovalSearchQuery('  hire   agent '), 'hire agent');
  });

  it('blank becomes empty string', () => {
    assert.strictEqual(normalizeApprovalSearchQuery(undefined), '');
    assert.strictEqual(normalizeApprovalSearchQuery('   '), '');
  });

  it('clamps to 200 chars', () => {
    assert.strictEqual(normalizeApprovalSearchQuery('x'.repeat(300)).length, 200);
  });
});

describe('Approval Filter - sections', () => {
  it('all shows both sections, awaiting/decided show one', () => {
    assert.deepStrictEqual(approvalSectionsForFilter('all'), { awaiting: true, decided: true });
    assert.deepStrictEqual(approvalSectionsForFilter('awaiting'), { awaiting: true, decided: false });
    assert.deepStrictEqual(approvalSectionsForFilter('decided'), { awaiting: false, decided: true });
  });
});

describe('Approval Filter - href building', () => {
  it('always includes status, omits empty query', () => {
    assert.strictEqual(approvalListHref('all'), '/approval?status=all');
    assert.strictEqual(approvalListHref('decided'), '/approval?status=decided');
  });

  it('includes and encodes the query', () => {
    assert.strictEqual(
      approvalListHref('awaiting', 'hire agent'),
      '/approval?status=awaiting&q=hire+agent',
    );
    assert.strictEqual(approvalListHref('all', ''), '/approval?status=all');
  });

  it('href round-trips through the parsers', () => {
    const href = approvalListHref('decided', 'Budget raise');
    const url = new URL(href, 'http://localhost:3002');
    assert.strictEqual(parseApprovalStatusFilter(url.searchParams.get('status') ?? undefined), 'decided');
    assert.strictEqual(normalizeApprovalSearchQuery(url.searchParams.get('q') ?? undefined), 'Budget raise');
  });
});
