/** Reject needs a reason in the board UI: the reason field is required, Approve skips that check. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('approval decision form: reject requires a reason', () => {
  let ApprovalDecisionForm: (p: { approvalId: string }) => React.ReactNode;
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ ApprovalDecisionForm } = (await import('./approval-decision-form')) as never);
  });

  it('reason textarea is required; Approve has formnovalidate, Reject does not', () => {
    const html = renderToStaticMarkup(React.createElement(ApprovalDecisionForm, { approvalId: 'appr-a' }));
    assert.match(html, /<form[^>]*action="\/api\/approvals\/appr-a\/decide"[^>]*method="POST"/);
    assert.match(html, /<textarea[^>]*name="note"[^>]*required=""/);
    const approve = /<button[^>]*value="approved"[^>]*>/.exec(html)?.[0] ?? '';
    const reject = /<button[^>]*value="rejected"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(approve, /formNoValidate=""|formnovalidate=""/i);
    assert.ok(reject && !/formnovalidate/i.test(reject), reject);
    assert.match(html, /Reason \(required to reject\)/);
    assert.match(html, /Board feedback/);
  });
});
