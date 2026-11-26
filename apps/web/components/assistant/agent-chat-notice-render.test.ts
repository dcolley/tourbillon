/**
 * TB-363 A12 (VERDICT MUST-1): a notice item in chat state must be DRAWN. ItemView in
 * agent-chat.tsx had cases for user / assistant / reasoning / tool only, so a kind 'notice'
 * item reached state.items and rendered as NOTHING — every upstream fix (emit, bridge,
 * persist, deliver) could be green while the human still saw no notice.
 *
 * These render the real AgentChatView over chat state built from the REAL stored row shape
 * (via chatItemsFromStoredMessages, as the live reload path does) and assert:
 *  - all four stages render;
 *  - the waiting_on_user notice shows the full ask text AND the "reply here" line;
 *  - the failed notice shows the reason;
 *  - each notice element carries data-item="notice" (also what use-sticky-transcript keys on);
 *  - the notice is never inside a tool/reasoning card and never doubled by a user bubble.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialAgentChatState, type AgentChatState } from '../../lib/agui/client/chat-state';
import { chatItemsFromStoredMessages, type StoredThreadMessage } from '../../lib/agui/client/thread-history';

type View = typeof import('./agent-chat');
let AgentChatView: View['AgentChatView'];

const noop = () => {};
function props(state: Partial<AgentChatState>) {
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
  };
}

/** Verbatim real Mastra 1.81 accepted-signal row (PG probe): text part + metadata.signal + type. */
const signalRow = (
  id: string,
  stage: string,
  contents: string,
  extra: Record<string, unknown> = {},
): StoredThreadMessage =>
  ({
    id,
    role: 'signal',
    content: {
      format: 2,
      parts: [{ type: 'text', text: contents }],
      metadata: {
        signal: {
          id,
          type: 'reactive',
          tagName: 'task-progress',
          attributes: { taskId: 'task-1', runId: 'run-1', stage, status: stage === 'failed' ? 'failed' : 'succeeded', ...extra },
        },
      },
    },
    type: 'task-progress',
  }) as unknown as StoredThreadMessage;

const ASK = 'Pick vendor A or B by Friday, then I continue';

describe('TB-363 A12: AgentChatView renders task-progress notices', () => {
  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ AgentChatView } = await import('./agent-chat'));
  });

  it('A12: every stage renders a [data-item=notice] element drawn from the item itself', () => {
    const rows = [
      signalRow('n-start', 'started', 'Background task started: "Ship the runbook".'),
      signalRow('n-ask', 'waiting_on_user', `Background task "Vendor call" is waiting on the human: ${ASK}. Ask them for exactly that; they can reply here, and the task resumes (status pending) when they answer.`, { title: 'Vendor call' }),
      signalRow('n-fail', 'failed', 'Background task "Nightly sync" FAILED: worker died (exit 137).', { title: 'Nightly sync' }),
      signalRow('n-done', 'done', 'Background task done: "Ship the runbook".', { title: 'Ship the runbook' }),
    ];
    const items = chatItemsFromStoredMessages(rows);
    assert.equal(items.filter((i) => i.kind === 'notice').length, 4, 'one notice item per stored row');
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items })));
    for (const stage of ['started', 'waiting_on_user', 'failed', 'done']) {
      assert.ok(
        html.includes(`data-item="notice"`) && html.includes(`data-stage="${stage}"`),
        `notice for stage ${stage} is rendered with data-item="notice"`,
      );
    }
    assert.equal((html.match(/data-item="notice"/g) ?? []).length, 4, 'exactly four notice elements');
    // The ask and the way to answer are VISIBLE (not truncated to a generic label).
    assert.ok(html.includes(ASK), 'the full ask text is visible in the transcript');
    assert.ok(/reply here/i.test(html), 'the notice says the human can reply here');
    assert.ok(html.includes('worker died (exit 137)'), 'the failure reason is visible');
    // Not wrapped in a tool/reasoning card, and no fake user bubble for the signal rows.
    assert.ok(!/data-item="tool"/.test(html), 'a notice never renders inside a tool card');
    assert.ok(!/data-item="reasoning"/.test(html), 'a notice never renders inside a reasoning card');
    assert.ok(!/data-item="user"/.test(html), 'the signal rows never render as user bubbles (MUST-2 double render)');
  });

  it('A12-order: notices render in transcript order alongside a real assistant reply', () => {
    const items = chatItemsFromStoredMessages([
      { id: 'u1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: 'track the vendor call' }] } } as unknown as StoredThreadMessage,
      signalRow('n-a', 'started', 'Background task started: "Vendor call".'),
      { id: 'a1', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: 'On it.' }] } } as unknown as StoredThreadMessage,
      signalRow('n-b', 'done', 'Background task done: "Vendor call".'),
    ]);
    const html = renderToStaticMarkup(React.createElement(AgentChatView, props({ items })));
    const pos = (needle: string) => html.indexOf(needle);
    assert.ok(pos('track the vendor call') < pos('data-stage="started"'), 'started notice after the user turn');
    assert.ok(pos('On it.') < pos('data-stage="done"'), 'done notice after the assistant reply');
  });
});
