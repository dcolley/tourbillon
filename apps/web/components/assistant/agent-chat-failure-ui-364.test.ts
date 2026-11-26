/**
 * TB-364 (A12/A14/A24/A25/A35/A36, S3): the failed-message UI. Renders the real AgentChatView over
 * chat state and asserts the selectors the acceptance harness keys on:
 *  - [data-item="user"][data-delivery="failed"] carries the failure block (role=alert);
 *  - [data-error-details-toggle] with aria-expanded; [data-error-details] ABSENT from the DOM while
 *    closed (never a native <details>); the raw technical text is not in the DOM until opened, and
 *    then only as escaped, bounded text (A25/A26);
 *  - data-action="retry" / "retry-other-model" / "discard";
 *  - waiting is labelled differently from queued; discarded stays visible greyed "Not sent";
 *  - an incomplete assistant item carries data-partial="true" + accessible name "incomplete" (A36).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  initialAgentChatState,
  type AgentChatItem,
  type AgentChatState,
  type MessageFailure,
} from '../../lib/agui/client/chat-state';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];

const noop = () => {};
function props(state: Partial<AgentChatState>, extra: Record<string, unknown> = {}) {
  return {
    phase: 'ready' as const,
    setupError: null,
    state: { ...initialAgentChatState, ...state },
    draft: '',
    onDraftChange: noop,
    onSend: noop,
    onSteer: noop,
    onStop: noop,
    onToolDecision: noop,
    onDismissError: noop,
    onRetryUser: noop,
    onDiscardUser: noop,
    onRetryUserOnModel: noop,
    retryModelChoices: [{ providerId: 'p1', modelId: 'other-model', label: 'Other model' }],
    ...extra,
  };
}

const serverFailure: MessageFailure = {
  category: 'server_error',
  retryable: true,
  friendly: { title: 'The agent could not finish', hint: 'You can retry this message.' },
  technical: 'Error: upstream 500 «redacted:endpoint» stack <script>alert(1)</script>',
};

const failedUser: AgentChatItem = {
  kind: 'user',
  id: 'u1',
  text: 'do the thing',
  mode: 'run',
  delivery: 'failed',
  clientMessageId: 'cmid-364-aaaa',
  attempts: 1,
  failure: serverFailure,
};

before(async () => {
  // button.tsx (base-ui wrapper) compiles with the classic JSX transform under tsx in this test
  // process and references the React binding as a global; Next injects it in the app, so mirror
  // that here for the render (test-process-only).
  (globalThis as Record<string, unknown>).React = React;
  AgentChatView = (await import('./agent-chat')).AgentChatView;
});

/** The markup of the failed user block (from its opening tag to the next user block or end). */
function userScope(html: string): string {
  const start = html.indexOf('data-item="user"');
  assert.ok(start >= 0, 'no user item rendered');
  const next = html.indexOf('data-item="user"', start + 10);
  return html.slice(start, next === -1 ? html.length : next);
}

describe('TB-364 failed-message UI (A24/A25/A35/A36)', () => {
  it('failed user item renders the failure block with the contract selectors, closed by default', () => {
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [failedUser] })));
    assert.match(html, /data-item="user"[^>]*data-delivery="failed"|data-delivery="failed"[^>]*data-item="user"/);
    // the message text stays in the transcript (A9) and the block is announced (S3)
    assert.match(html, /do the thing/);
    assert.match(html, /role="alert"/);
    // buttons (A3/A4/A14)
    assert.match(html, /data-action="retry"/);
    assert.match(html, /data-action="retry-other-model"/);
    assert.match(html, /data-action="discard"/);
    // toggle closed: aria-expanded=false and NO details node in the DOM (A25; not a native <details>)
    assert.match(html, /data-error-details-toggle=""/);
    assert.match(html, /aria-expanded="false"/);
    const scope = userScope(html);
    assert.ok(!scope.includes('data-error-details='), '[data-error-details] must be ABSENT while closed');
    assert.ok(!scope.includes('<details'), 'failure details must not use a native <details>');
    // A24: the raw technical text is NOT in the DOM by default; only the friendly copy is
    assert.ok(!scope.includes('<script>alert(1)&gt;') && !scope.includes('upstream 500'), 'raw technical must not render closed');
    assert.match(scope, /The agent could not finish/);
    assert.match(scope, /You can retry this message\./);
  });

  it('open state renders bounded, ESCAPED technical text (A25/A26) with aria-expanded=true', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentChatView, props({ items: [failedUser] }, { detailsOpenByDefault: true })),
    );
    const scope = userScope(html);
    assert.match(html, /aria-expanded="true"/);
    assert.match(scope, /data-error-details=""/);
    assert.ok(scope.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'technical must be escaped text, never markup');
    assert.ok(!/<script>alert\(1\)<\/script>/.test(scope), 'no executable script in the details');
  });

  it('long technical text is bounded with a visible truncation marker (A26)', () => {
    const long: AgentChatItem = {
      ...failedUser,
      failure: { ...serverFailure, technical: 'x'.repeat(5000) + 'SECRET-TAIL' },
    };
    const html = renderToStaticMarkup(
      React.createElement(AgentChatView, props({ items: [long] }, { detailsOpenByDefault: true })),
    );
    const scope = userScope(html);
    assert.match(scope, /\[truncated\]/);
    assert.ok(!scope.includes('SECRET-TAIL'), 'beyond the bound must not render');
  });

  it('toolRan warns; partial notes the kept output (A20/A36)', () => {
    const toolRan: AgentChatItem = { ...failedUser, failure: { ...serverFailure, toolRan: true } };
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [toolRan] })));
    assert.match(userScope(html), /tool already ran/i);
    const partial: AgentChatItem = { ...failedUser, failure: { ...serverFailure, partial: true } };
    const html2 = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [partial] })));
    assert.match(userScope(html2), /Part of the reply/i);
  });

  it('waiting and queued carry DISTINCT labels; discarded stays visible greyed "Not sent" (A12/A14/A35)', () => {
    const mk = (delivery: AgentChatItem extends never ? never : 'waiting' | 'queued' | 'discarded', id: string): AgentChatItem => ({
      kind: 'user',
      id,
      text: `msg ${id}`,
      mode: delivery === 'queued' ? 'followUp' : 'run',
      delivery,
    });
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [mk('waiting', 'w'), mk('queued', 'q'), mk('discarded', 'd')] })));
    assert.match(html, /data-delivery="waiting"/);
    assert.match(html, /Waiting — runs once the failed message above is resolved/);
    assert.match(html, /Queued — runs after the current reply/);
    assert.match(html, /data-delivery="discarded"/);
    // discarded keeps its text visible (never removed), greyed via the muted bubble class
    assert.match(html, /msg d/);
    const notSent = html.split('data-delivery="discarded"')[1]?.slice(0, 600) ?? '';
    assert.match(notSent, /Not sent/);
  });

  it('incomplete assistant item is marked, kept, and named incomplete (A36)', () => {
    const items: AgentChatItem[] = [
      { ...failedUser, failure: { ...serverFailure, partial: true } },
      { kind: 'assistant', id: 'a1', text: 'half an answer', streaming: false, partial: true },
    ];
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items })));
    assert.match(html, /data-item="assistant"[^>]*data-partial="true"|data-partial="true"[^>]*data-item="assistant"/);
    assert.match(html, /half an answer/);
    assert.match(html, /incomplete/i);
  });

  it('retrying item shows the retrying label and disabled Retry with countdown copy (A21)', () => {
    const retrying: AgentChatItem = {
      ...failedUser,
      delivery: 'retrying',
      nextRetryAt: Date.now() + 4000,
    };
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items: [retrying] })));
    assert.match(html, /data-delivery="retrying"/);
    assert.match(html, /Retrying…/);
    const scope = userScope(html);
    assert.match(scope, /data-action="retry"[^>]*disabled|disabled[^>]*data-action="retry"/);
    assert.match(scope, /Retrying in \d+ s/);
  });

  it('read-only view (no handlers) still renders the block without action buttons throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AgentChatView,
        { ...props({ items: [failedUser] }), onRetryUser: undefined, onDiscardUser: undefined, onRetryUserOnModel: undefined, retryModelChoices: undefined },
      ),
    );
    assert.match(html, /data-error-details-toggle=""/);
    assert.match(html, /role="alert"/);
  });
});
