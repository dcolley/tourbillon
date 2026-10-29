/**
 * ASYNC-0: single conversation per agent — chat path, Clear chat (a fresh thread via the existing
 * thread API, Slice A), and the ⋯ menu items (with the OM mode, Slice B).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentChatMenuItems, agentChatPath, agentOmMenuLabel, agentOmSettingsHref, chatOmSummary, clearAgentChat, isAssistantOmSummary } from './single-chat';
import type { AgentRuntimeConfig, CompanySettings } from '@tourbillon/shared';

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

  it('Clear chat passes on the OM mode the server reports for the new thread (Slice B)', async () => {
    calls = [];
    const om = { mode: 'on', active: true };
    assert.deepEqual(await clearAgentChat('a', { fetch: respond(201, { thread: { id: 't2' }, activeThreadId: 't2', observationalMemory: om }) }), {
      ok: true,
      threadId: 't2',
      observationalMemory: om,
    });
    // A malformed OM summary is ignored, not passed on.
    assert.deepEqual(await clearAgentChat('a', { fetch: respond(201, { thread: { id: 't3' }, observationalMemory: { mode: 'weird' } }) }), {
      ok: true,
      threadId: 't3',
    });
  });

  it('menu: the Observational Memory item shows the current mode and links to Control Pane to change it (Slice B)', () => {
    assert.equal(agentOmMenuLabel(null), 'Observational Memory');
    assert.equal(agentOmMenuLabel({ mode: 'off', active: false }), 'Observational Memory: Off');
    assert.equal(agentOmMenuLabel({ mode: 'on', active: true }), 'Observational Memory: On');
    assert.equal(agentOmMenuLabel({ mode: 'on', active: false }), 'Observational Memory: On (not configured)');
    assert.equal(agentOmMenuLabel({ mode: 'inherit', active: true }), 'Observational Memory: Inherit (on)');
    assert.equal(agentOmMenuLabel({ mode: 'inherit', active: false }), 'Observational Memory: Inherit (off)');
    const items = agentChatMenuItems({ agentUrlKey: 'ceo', runOpen: false, observationalMemory: { mode: 'inherit', active: true } });
    assert.deepEqual(
      items.map((i) => i.label),
      ['Clear chat', 'Observational Memory: Inherit (on)'],
    );
    assert.equal(items[1].href, '/agent/ceo?view=overview&config=om');
    assert.equal(items[1].hint, 'Change in Control Pane');
    assert.equal(items[1].disabled, undefined, 'read-only display, still a link');
    assert.equal(isAssistantOmSummary({ mode: 'off', active: false }), true);
    assert.equal(isAssistantOmSummary({ mode: 'off' }), false);
    assert.equal(isAssistantOmSummary(null), false);
  });
});

/**
 * CONCIERGE-OM B1: free-chat forces OM on (resolveChatObservationalMemory), so the menu must be
 * built from the CHAT resolver. Regressing assistantOmSummary/agentOmMenuLabel to the heartbeat
 * resolver makes these fail (chat runs OM while the menu claims "Off" / "Inherit (off)").
 */
describe('chatOmSummary + agentOmMenuLabel (CONCIERGE-OM B1: menu shows the CHAT OM state)', () => {
  const OFF_MODEL: CompanySettings = {
    observationalMemory: { enabled: false, providerId: 'p1', modelId: 'om-model' },
  };

  it('heartbeats off, chat on: active=true, heartbeatActive=false (heartbeat resolver would say inactive)', () => {
    const s = chatOmSummary(OFF_MODEL, { observationalMemory: { mode: 'off' } } as AgentRuntimeConfig);
    assert.deepEqual(s, { mode: 'off', active: true, heartbeatActive: false });
    assert.equal(agentOmMenuLabel(s), 'Observational Memory: On in chat · heartbeats Off');
  });

  it('inherit + company OM disabled: still on in chat via the concierge model', () => {
    const s = chatOmSummary({ conciergeModel: { providerId: 'p1', modelId: 'front-desk' } }, null);
    assert.deepEqual(s, { mode: 'inherit', active: true, heartbeatActive: false });
    assert.equal(agentOmMenuLabel(s), 'Observational Memory: On in chat · heartbeats Off');
  });

  it('no observer model anywhere: honest off labels (unchanged copy)', () => {
    assert.equal(agentOmMenuLabel(chatOmSummary({}, { observationalMemory: { mode: 'off' } } as AgentRuntimeConfig)), 'Observational Memory: Off');
    assert.equal(agentOmMenuLabel(chatOmSummary({}, { observationalMemory: { mode: 'inherit' } } as AgentRuntimeConfig)), 'Observational Memory: Inherit (off)');
  });

  it('heartbeats on too: plain On/Inherit (on) labels — no chat-only copy', () => {
    const s = chatOmSummary(
      { observationalMemory: { enabled: true, providerId: 'p1', modelId: 'om-model' } },
      { observationalMemory: { mode: 'inherit' } } as AgentRuntimeConfig,
    );
    assert.deepEqual(s, { mode: 'inherit', active: true, heartbeatActive: true });
    assert.equal(agentOmMenuLabel(s), 'Observational Memory: Inherit (on)');
  });
});

/**
 * S194-S7 (#194 ACCEPT): mode:'on' + an agent-only observer model (agent OM overrides, no
 * company OM pair, no concierge model). The chat resolver never sees the agent override
 * (company OM → concierge → none), so chat has no observer (active=false) while heartbeats
 * DO run OM (heartbeatActive=true). The menu must not claim "not configured" there.
 * Reverting the label branch to `On (not configured)` fails the first two assertions.
 */
describe('agentOmMenuLabel (S194-S7: mode on + agent-only model is not "not configured")', () => {
  const AGENT_ONLY = {
    observationalMemory: { mode: 'on', providerId: 'p-agent', modelId: 'agent-observer' },
  } as unknown as AgentRuntimeConfig;

  it('chat off + heartbeats on the agent model: summary says so, label drops "not configured"', () => {
    const s = chatOmSummary({}, AGENT_ONLY);
    assert.deepEqual(s, { mode: 'on', active: false, heartbeatActive: true });
    assert.equal(agentOmMenuLabel(s), 'Observational Memory: On in heartbeats · chat Off');
    const items = agentChatMenuItems({ agentUrlKey: 'ceo', runOpen: false, observationalMemory: s });
    assert.equal(items[1].label, 'Observational Memory: On in heartbeats · chat Off');
  });

  it('genuinely unconfigured (no agent override either) keeps the honest "not configured" copy', () => {
    const s = chatOmSummary({}, { observationalMemory: { mode: 'on' } } as AgentRuntimeConfig);
    assert.deepEqual(s, { mode: 'on', active: false, heartbeatActive: false });
    assert.equal(agentOmMenuLabel(s), 'Observational Memory: On (not configured)');
  });

  it('legacy payload without heartbeatActive is unchanged', () => {
    assert.equal(agentOmMenuLabel({ mode: 'on', active: false }), 'Observational Memory: On (not configured)');
    assert.equal(agentOmMenuLabel({ mode: 'on', active: true }), 'Observational Memory: On');
  });
});
