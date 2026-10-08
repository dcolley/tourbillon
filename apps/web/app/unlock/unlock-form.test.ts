/**
 * UX-1: /unlock uses PasswordInput and still submits.
 * No DOM test library in the repo: markup via react-dom/server, submit logic via postBoardSession.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('UX-1 /unlock form', () => {
  let UnlockForm: (p: { next: string }) => React.ReactNode;
  let postBoardSession: (secret: string, fetchImpl?: typeof fetch) => Promise<string>;

  before(async () => {
    (globalThis as { React?: unknown }).React = React;
    ({ UnlockForm, postBoardSession } = (await import('./unlock-form')) as never);
  });

  it('secret input is hidden by default with a non-submitting Show secret toggle; Unlock is the only submit button', () => {
    const html = renderToStaticMarkup(React.createElement(UnlockForm, { next: '/' }));
    assert.match(html, /<form/);
    assert.match(html, /<input[^>]*id="board-secret"[^>]*type="password"|<input[^>]*type="password"[^>]*id="board-secret"/);
    assert.match(html, /autoComplete="current-password"|autocomplete="current-password"/);
    assert.match(html, /<input[^>]*required/);
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.equal(buttons.length, 2);
    const toggle = buttons.find((b) => b.includes('aria-label="Show secret"'));
    assert.ok(toggle && /type="button"/.test(toggle), 'toggle is type=button, so Enter/implicit submit uses Unlock');
    const submits = buttons.filter((b) => /type="submit"/.test(b));
    assert.equal(submits.length, 1, 'exactly one submit button (Unlock)');
    assert.ok(!submits[0].includes('Show secret'));
  });

  it('postBoardSession posts the secret as JSON to /api/board/session and maps the result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    assert.equal(await postBoardSession('op-secret-123', ok), 'ok');
    assert.equal(calls[0].url, '/api/board/session');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { secret: 'op-secret-123' });

    const denied = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    assert.equal(await postBoardSession('wrong', denied), 'invalid');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    assert.equal(await postBoardSession('x', down), 'unreachable');
  });
});
