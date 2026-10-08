import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDetailHref, legacyApprovalRedirect } from './approval-links';

describe('approval links', () => {
  it('detail href is /approval/<id> (encoded)', () => {
    assert.equal(approvalDetailHref('a0000001-0000-4000-8000-000000000001'), '/approval/a0000001-0000-4000-8000-000000000001');
    assert.equal(approvalDetailHref('x/../y?z'), '/approval/x%2F..%2Fy%3Fz');
  });
  it('/approval?id=<id> redirects to the details page; no id → list', () => {
    assert.equal(legacyApprovalRedirect({ id: 'abc' }), '/approval/abc');
    assert.equal(legacyApprovalRedirect({ id: ['abc', 'def'] }), '/approval/abc');
    assert.equal(legacyApprovalRedirect({ id: 'https://evil.example/' }), '/approval/https%3A%2F%2Fevil.example%2F');
    assert.equal(legacyApprovalRedirect({}), null);
    assert.equal(legacyApprovalRedirect({ id: '  ' }), null);
    assert.equal(legacyApprovalRedirect(undefined), null);
  });
});
