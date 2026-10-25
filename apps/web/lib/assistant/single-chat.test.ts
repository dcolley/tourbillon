/**
 * ASYNC-0 (Slice A): single conversation per agent — chat path, Clear chat (a fresh thread via the
 * existing thread API), and the ⋯ menu items.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentChatMenuItems, agentChatPath, agentOmSettingsHref, clearAgentChat } from './single-chat';

const respond = (status: number, body: unknown) =>
  (async (url: string, init?: RequestInit) => {
    calls.push([url, init?.method ?? 'GET', init?.body]);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
let calls: Array<[string, string, unknown]> = [];

describe('ASYNC-0 single agent chat', () => {
  it('the chat path is the agent root; OM settings link to the Control Pane OM tab', () => {
    assert.equal(agentChatPath('ceo'), '/assistant/ceo');
    assert.equal(agentChatPath('a b'), '/assistant/a%20b');
    assert.equal(agentOmSettingsHref('ceo'), '/agent/ceo?view=overview&config=om');
    assert.equal(agentOmSettingsHref('a/b'), '/agent/a%2Fb?view=overview&config=om');
  });

  it('Clear chat POSTs a new thread for the agent and returns its id', async () => {
    calls = [];
    const r = await clearAgentChat('agent 1', { fetch: respond(201, { thread: { id: 't-new' } }) });
    assert.deepEqual(r, { ok: true, threadId: 't-new' });
    assert.deepEqual(calls, [['/api/assistant/agents/agent%201/threads', 'POST', '{}']]);
  });

  it('Clear chat failures: server message (e.g. rate limit), fallback text, network error, bad body', async () => {
    assert.deepEqual(await clearAgentChat('a', { fetch: respond(429, { error: 'Too many new threads; try again shortly' }) }), {
      ok: false,
      error: 'Too many new threads; try again shortly',
    });
    assert.deepEqual(await clearAgentChat('a', { fetch: respond(500, 'oops') }), { ok: false, error: 'Could not clear the chat' });
    assert.deepEqual(await clearAgentChat('a', { fetch: respond(201, {}) }), { ok: false, error: 'Could not clear the chat' });
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    assert.deepEqual(await clearAgentChat('a', { fetch: down }), { ok: false, error: 'Could not clear the chat' });
  });

  it('menu: Clear chat and Observational Memory only (no New chat); Clear disabled while a run is open or clearing', () => {
    const idle = agentChatMenuItems({ agentUrlKey: 'ceo', runOpen: false });
    assert.deepEqual(idle.map((i) => i.label), ['Clear chat', 'Observational Memory']);
    assert.equal(idle[0].disabled, false);
    assert.equal(idle[1].href, '/agent/ceo?view=overview&config=om');
    const running = agentChatMenuItems({ agentUrlKey: 'ceo', runOpen: true });
    assert.equal(running[0].disabled, true);
    assert.equal(running[0].hint, 'Stop or wait for the current reply first');
    const clearing = agentChatMenuItems({ agentUrlKey: 'ceo', runOpen: false, clearing: true });
    assert.equal(clearing[0].disabled, true);
    assert.equal(clearing[0].hint, 'Clearing…');
  });
});
