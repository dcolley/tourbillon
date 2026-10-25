/**
 * WID-2: the approval card widget — which tool calls show it, how each answer type renders (from
 * the hitl v0 fields), the decide body it sends, and that nothing secret or token-like is shown.
 * No DOM test library in the repo: markup via react-dom/server; the stateless body is rendered
 * directly and the stateful widget renders its loading state through the registry.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalCardData, ApprovalCardInput } from '../../../lib/approval-card-view';

type Card = typeof import('./approval-card');
type View = typeof import('../../../lib/approval-card-view');
type Binding = typeof import('./approval-card-binding');

let ApprovalCardBody: Card['ApprovalCardBody'];
let initialCardValue: Card['initialCardValue'];
let SECRET_REFUSAL: string;
let view: View;
let approvalCardCallFor: Binding['approvalCardCallFor'];
let WidgetToolCall: typeof import('./widget-tool-call').WidgetToolCall;
let assistantWidgetRegistry: typeof import('./registry').assistantWidgetRegistry;
let AgentChatView: typeof import('../agent-chat').AgentChatView;
let initialAgentChatState: typeof import('../../../lib/agui/client/chat-state').initialAgentChatState;

const card = (over: Partial<ApprovalCardData> = {}): ApprovalCardData => ({
  id: 'appr_1',
  status: 'pending',
  title: 'Issue a £240 refund for order 48213?',
  requestedBy: 'CEO',
  createdAt: '2026-10-24T09:00:00.000Z',
  typed: true,
  answerType: 'binary',
  options: [
    { value: 'approve', label: 'Approve' },
    { value: 'reject', label: 'Reject' },
  ],
  bounds: {},
  reasonRequired: ['reject'],
  items: [],
  deadline: null,
  detailsPath: '/approval/appr_1',
  ...over,
});
const single = (over: Partial<ApprovalCardData> = {}) =>
  card({
    title: 'Which carrier should ship the replacement?',
    answerType: 'single',
    options: [
      { value: 'dpd', label: 'DPD next day', description: 'Tracked' },
      { value: 'evri', label: 'Evri' },
    ],
    recommended: { value: 'dpd', reason: 'Fastest.' },
    default: 'evri',
    reasonRequired: [],
    ...over,
  });

const noop = () => {};
/** The <input> tag for one option value (attribute order is React's, not ours). */
function inputTag(html: string, type: string, value: string): string {
  const tag = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`type="${type}"`) && t.includes(`value="${value}"`));
  assert.ok(tag, `${type} input for ${value}`);
  return tag;
}
function render(c: ApprovalCardData, draft: ApprovalCardInput = {}, extra: { error?: string } = {}) {
  return renderToStaticMarkup(
    React.createElement(ApprovalCardBody, { card: c, draft, onDraftChange: noop, onSubmit: noop, onRefresh: noop, ...extra }),
  );
}

describe('WID-2 approval card', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ ApprovalCardBody, initialCardValue, SECRET_REFUSAL } = await import('./approval-card'));
    view = await import('../../../lib/approval-card-view');
    ({ approvalCardCallFor } = await import('./approval-card-binding'));
    ({ WidgetToolCall } = await import('./widget-tool-call'));
    ({ assistantWidgetRegistry } = await import('./registry'));
    ({ AgentChatView } = await import('../agent-chat'));
    ({ initialAgentChatState } = await import('../../../lib/agui/client/chat-state'));
  });

  describe('binding: which chat tool calls show the card', () => {
    const tool = (over: Record<string, unknown> = {}) => ({ id: 'call-1', name: 'createApproval', status: 'done', result: JSON.stringify({ id: 'appr_1', status: 'pending' }), ...over });

    it('a finished createApproval / getApproval call with an approval id becomes approvalCard', () => {
      for (const name of ['createApproval', 'createApprovalTool', 'getApproval', 'getApprovalTool']) {
        assert.deepEqual(approvalCardCallFor(tool({ name })), { toolCallId: 'call-1', toolName: 'approvalCard', args: { approvalId: 'appr_1' } }, name);
      }
      assert.deepEqual(approvalCardCallFor(tool({ name: 'getApproval', result: JSON.stringify({ approval: { id: 'appr_2' } }) }))?.args, { approvalId: 'appr_2' });
    });

    it('anything else keeps its own rendering', () => {
      for (const t of [
        tool({ status: 'running' }),
        tool({ status: 'error' }),
        tool({ name: 'listApprovals' }),
        tool({ result: undefined }),
        tool({ result: 'not json' }),
        tool({ result: JSON.stringify({ error: 'HTTP 422', id: 'x' }) }),
        tool({ result: JSON.stringify({ error: 'invalid_question', fields: [] }) }),
        tool({ result: JSON.stringify({ id: '../../admin' }) }),
        tool({ result: JSON.stringify([{ id: 'appr_1' }]) }),
      ]) {
        assert.equal(approvalCardCallFor(t), null, JSON.stringify(t));
      }
    });

    it('the registry resolves the card from the id alone; extra props fall back', () => {
      assert.ok(assistantWidgetRegistry.resolve({ toolCallId: 'c', toolName: 'approvalCard', args: { approvalId: 'appr_1' } }).ok);
      assert.equal(assistantWidgetRegistry.resolve({ toolCallId: 'c', toolName: 'approvalCard', args: { approvalId: 'appr_1', token: 't' } }).ok, false);
    });

    it('the chat renders a finished createApproval call as the card (loading until fetched)', () => {
      const html = renderToStaticMarkup(
        React.createElement(AgentChatView, {
          phase: 'ready',
          setupError: null,
          state: {
            ...initialAgentChatState,
            items: [
              { kind: 'tool', id: 't1', name: 'createApproval', argsText: '{"title":"Ship"}', status: 'done', result: JSON.stringify({ id: 'appr_1', status: 'pending' }) },
              { kind: 'tool', id: 't2', name: 'createApproval', argsText: '{}', status: 'running' },
            ],
          },
          draft: '',
          onDraftChange: noop,
          onSend: noop,
          onSteer: noop,
          onStop: noop,
          onToolDecision: noop,
          onDismissError: noop,
        } as never),
      );
      assert.match(html, /data-widget="approvalCard"[^>]*data-tool-call-id="t1"/);
      assert.match(html, /data-approval-card="appr_1"[^>]*data-approval-status="loading"/);
      assert.match(html, /data-widget="fallback"/, 'the running call keeps the fallback card');
    });

    it('WidgetToolCall renders the registered widget for the bound call', () => {
      const call = approvalCardCallFor({ id: 'call-1', name: 'createApproval', status: 'done', result: '{"id":"appr_9"}' })!;
      const html = renderToStaticMarkup(React.createElement(WidgetToolCall, { registry: assistantWidgetRegistry, toolCall: call }));
      assert.match(html, /data-widget="approvalCard"/);
      assert.match(html, /Loading approval/);
    });
  });

  describe('render (hitl v0 fields)', () => {
    it('binary: question, requester, Approve / Reject / Decline, reason required for reject, details link', () => {
      const html = render(card({ deadline: '2026-10-25T12:00:00.000Z', risk: { level: 'high', reversible: false } }));
      assert.match(html, /Issue a £240 refund for order 48213\?/);
      assert.match(html, /Requested by CEO/);
      assert.match(html, /data-action="approve"/);
      assert.match(html, /data-action="reject"/);
      assert.match(html, /data-action="decline"/);
      assert.match(html, /required for: Reject/);
      assert.match(html, /href="\/approval\/appr_1"/);
      assert.match(html, /Deadline: <time dateTime="2026-10-25T12:00:00.000Z">2026-10-25 12:00 UTC/);
      assert.match(html, /Risk: high · irreversible/);
    });

    it('legacy approval (no question): title and summary, Approve / Reject, no Decline', () => {
      const html = render(card({ typed: false, title: 'Ship it', summary: 'Release 1.2', options: [], reasonRequired: [] }));
      assert.match(html, /Ship it/);
      assert.match(html, /Release 1\.2/);
      assert.match(html, /data-action="approve"/);
      assert.doesNotMatch(html, /data-action="decline"/);
      assert.doesNotMatch(html, /required for/);
    });

    it('single: options with descriptions, recommended highlighted (not selected), default selected', () => {
      const c = single();
      const html = render(c, { value: initialCardValue(c) });
      assert.match(html, /Recommended: DPD next day<\/span><span[^>]*> — Fastest\./);
      assert.doesNotMatch(inputTag(html, 'radio', 'dpd'), /checked/);
      assert.match(inputTag(html, 'radio', 'evri'), /checked/);
      assert.match(html, /Tracked/);
      assert.match(html, /data-action="answer"/);
    });

    it('multi: checkboxes and item bounds; number: bounds and unit; text: max length', () => {
      const multi = render(single({ answerType: 'multi', default: undefined, recommended: undefined, bounds: { minItems: 1, maxItems: 2 } }), { value: ['dpd'] });
      assert.match(multi, /Pick one or more \(1–2\)/);
      assert.match(inputTag(multi, 'checkbox', 'dpd'), /checked/);
      assert.doesNotMatch(inputTag(multi, 'checkbox', 'evri'), /checked/);
      const num = render(card({ answerType: 'number', options: [], reasonRequired: [], bounds: { min: 0, max: 500, step: 10, unit: 'GBP' } }), { value: '120' });
      assert.match(num, /0 to 500, step 10 GBP/);
      assert.match(inputTag(num, 'number', '120'), /max="500"/);
      const text = render(card({ answerType: 'text', options: [], reasonRequired: [], bounds: { maxLength: 80 } }));
      assert.match(text, /max 80 characters/);
    });

    it('secret: refusal message and Decline only (no answer control)', () => {
      const html = render(card({ answerType: 'secret', options: [], reasonRequired: [] }));
      assert.ok(html.includes(SECRET_REFUSAL.slice(0, 40)));
      assert.match(html, /data-action="decline"/);
      for (const a of ['approve', 'reject', 'answer']) assert.doesNotMatch(html, new RegExp(`data-action="${a}"`));
    });

    it('mustOpen items: listed by label (no URL), answer blocked until opened on the approval page', () => {
      const items = [{ ref: 'lnk_terms', kind: 'link' as const, label: 'Terms', mustOpen: true, opened: false }];
      const html = render(card({ items }));
      assert.match(html, /data-testid="approval-card-must-open"/);
      assert.match(html, /Open &quot;Terms&quot; on the/);
      assert.doesNotMatch(html, /https?:\/\//);
      assert.doesNotMatch(html, /\/o\//);
      const opened = render(card({ items: [{ ...items[0], opened: true }] }));
      assert.doesNotMatch(opened, /approval-card-must-open/);
      assert.match(opened, /data-opened="true"/);
    });

    it('decided: response summary, no controls; secret answers are never shown', () => {
      const html = render(card({ status: 'answered', response: { status: 'answered', answer: 'Evri', reason: 'Cheaper', decidedBy: 'Board' } }));
      assert.match(html, /Answered · Evri · by Board/);
      assert.match(html, /Reason: Cheaper/);
      assert.doesNotMatch(html, /approval-card-controls/);
      const expired = render(card({ status: 'expired', response: { status: 'expired' } }));
      assert.match(expired, /Expired/);
      assert.doesNotMatch(expired, /data-action=/);
    });

    it('an error from the decide route is shown as an alert', () => {
      assert.match(render(card(), {}, { error: 'This approval was already decided.' }), /role="alert"[^>]*>This approval was already decided\./);
    });
  });

  describe('decide body (same shapes as the /approval form)', () => {
    it('binary: decision approved / rejected with the reason', () => {
      assert.deepEqual(view.approvalCardDecisionBody(card(), { value: 'approve' }), { ok: true, body: { decision: 'approved' } });
      assert.deepEqual(view.approvalCardDecisionBody(card(), { value: 'reject', reason: 'No' }), { ok: true, body: { decision: 'rejected', reason: 'No' } });
    });

    it('single / multi / number / text: status answered with a typed value', () => {
      assert.deepEqual(view.approvalCardDecisionBody(single(), { value: 'evri' }), { ok: true, body: { status: 'answered', value: 'evri' } });
      const numOpts = card({ answerType: 'single', options: [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }] });
      assert.deepEqual(view.approvalCardDecisionBody(numOpts, { value: '2' }), { ok: true, body: { status: 'answered', value: 2 } });
      assert.deepEqual(view.approvalCardDecisionBody(single({ answerType: 'multi' }), { value: 'dpd' }), { ok: true, body: { status: 'answered', value: ['dpd'] } });
      assert.deepEqual(view.approvalCardDecisionBody(card({ answerType: 'number' }), { value: ' 12.5 ' }), { ok: true, body: { status: 'answered', value: 12.5 } });
      assert.equal(view.approvalCardDecisionBody(card({ answerType: 'number' }), { value: '12abc' }).ok, false);
      assert.deepEqual(view.approvalCardDecisionBody(card({ answerType: 'text' }), { value: 'hello', reason: '  ' }), { ok: true, body: { status: 'answered', value: 'hello' } });
      assert.equal(view.approvalCardDecisionBody(single(), {}).ok, false);
    });

    it('decline: typed only; secret answers are refused before sending', () => {
      assert.deepEqual(view.approvalCardDecisionBody(single(), { decline: true, reason: 'Ask first' }), { ok: true, body: { status: 'declined', reason: 'Ask first' } });
      assert.equal(view.approvalCardDecisionBody(card({ typed: false }), { decline: true }).ok, false);
      const secret = view.approvalCardDecisionBody(card({ answerType: 'secret' }), { value: 'k' });
      assert.equal(secret.ok, false);
      assert.deepEqual(view.approvalCardDecisionBody(card({ answerType: 'secret' }), { decline: true }), { ok: true, body: { status: 'declined' } });
    });

    it('error text: field messages first, then 409 already decided / expired', () => {
      assert.equal(view.approvalCardErrorText(422, { error: 'Invalid answer', fields: [{ message: '"Terms" must be opened before answering' }] }), '"Terms" must be opened before answering');
      assert.equal(view.approvalCardErrorText(409, { error: 'Already decided' }), 'This approval was already decided.');
      assert.equal(view.approvalCardErrorText(409, { error: 'Expired', status: 'expired' }), 'This request expired before a decision.');
      assert.equal(view.approvalCardErrorText(404, null), 'Approval not found.');
    });
  });
});
