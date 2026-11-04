/**
 * #281 AC5 — harness chat pins (Soft Pack E · S316-S3 / S322-S5).
 *
 *  - auth fail-closed: no/invalid token ⇒ 401 before ANY bind/body/gate work; DM never sent.
 *  - unsupported ⇒ clear refuse: no bind / in-product agent / bind without `chat` / malformed
 *    bind ⇒ 409 chat_not_supported; leg not advertised ⇒ 409 chat_{sync,stream}_not_supported
 *    (stream FAILS CLOSED when only sync is advertised).
 *  - 501 gone for supported binds: Hermes sync / Hermes stream / OpenCode sync ⇒ 200.
 *  - capability deny: sendToAgent absent from assembleAgentTools ⇒ 403 chat_not_permitted and
 *    the DM tool NEVER executes (sentinel).
 *  - delivery runs the GATED DM tool with the run session token as apiKey (no second stack).
 *  - S327-S3: combined-failure ordering — an unadvertised leg is 409 even with bad text /
 *    recipient; 400s (method, text, recipient) all fire BEFORE the 403 gate (assembly never
 *    runs); text 400 precedes recipient 400. Route glue: invalid JSON ⇒ 401 without auth,
 *    400 only after auth; stream 200 carries the SSE headers.
 *  - S327-S4: stream delivery failure = HTTP 200 + final `failed` (sync = 502).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { handleHarnessChat, handleHarnessToolCall, resolveHarnessChatCapability, type HarnessCallbackDeps } from './callback-gate';
import { harnessChatPost } from './callback-http';

interface Sent {
  key: string;
  args: unknown;
  apiKey: unknown;
  runId: unknown;
  agentId: unknown;
}

const HERMES_HTTP = {
  harness: 'hermes',
  mode: 'local',
  localBaseUrl: 'http://127.0.0.1:8642',
} as const;
const OPENCODE_HTTP = {
  harness: 'opencode',
  mode: 'local',
  localBaseUrl: 'http://127.0.0.1:4096',
} as const;

function makeDeps(opts: {
  adapterConfig?: Record<string, unknown> | null;
  authenticated?: boolean;
  /** Keys present in the assembled tool set (default: DM tool granted). */
  toolKeys?: string[];
  dmResult?: unknown;
  dmThrows?: boolean;
  assembleThrows?: boolean;
} = {}) {
  const sent: Sent[] = [];
  const calls = { authenticate: 0, loadAgent: 0, assemble: 0 };
  const toolKeys = opts.toolKeys ?? ['getIdentityTool', 'sendToAgentTool'];
  const deps: HarnessCallbackDeps = {
    authenticate: async (token) => {
      calls.authenticate += 1;
      return opts.authenticated === false || !token || token === 'bad'
        ? null
        : { agentId: 'agent-1', companyId: 'company-1', runId: 'run-1' };
    },
    loadAgent: async () => {
      calls.loadAgent += 1;
      return {
        id: 'agent-1',
        companyId: 'company-1',
        ...(opts.adapterConfig === null ? {} : { adapterConfig: opts.adapterConfig ?? { ...HERMES_HTTP, chat: { sync: true, stream: true } } }),
      };
    },
    loadCompany: async () => ({ allowedMcpServerIds: ['srv-a'], settings: { foo: 1 } }),
    assembleTools: async (_agent, options) => {
      calls.assemble += 1;
      if (opts.assembleThrows) throw new Error('assembly exploded');
      assert.deepEqual(options.allowedMcpServerIds, ['srv-a']);
      assert.deepEqual(options.companySettings, { foo: 1 });
      const tools: Record<string, unknown> = {};
      for (const key of toolKeys) {
        const id = key.replace(/Tool$/, '');
        tools[key] = {
          id,
          description: `${id} tool`,
          inputSchema:
            id === 'sendToAgent'
              ? z.object({
                  toAgentId: z.string().optional(),
                  toAgentUrlKey: z.string().optional(),
                  body: z.string(),
                  inReplyTo: z.string().optional(),
                })
              : undefined,
          execute: async (args: unknown, context: { requestContext: { get: (k: string) => unknown } }) => {
            if (id === 'sendToAgent' && opts.dmThrows) throw new Error('mail api down');
            sent.push({
              key,
              args,
              apiKey: context.requestContext.get('apiKey'),
              runId: context.requestContext.get('runId'),
              agentId: context.requestContext.get('agentId'),
            });
            return id === 'sendToAgent' ? (opts.dmResult ?? { id: 'mail-1', ok: true }) : { ok: true };
          },
        };
      }
      return tools;
    },
    buildRequestContext: (values) => {
      const map = new Map<string, unknown>(Object.entries(values));
      return { get: (k: string) => map.get(k) };
    },
    newId: () => 'msg-fixed',
  };
  return { deps, sent, calls };
}

const AUTH = 'Bearer pm_run_token_abc';

function chatBody(method = 'message/send', overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 'req-1',
    method,
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'm-1',
        parts: [{ kind: 'text', text: 'Can you review PR 12?' }],
        metadata: { tourbillon: { toAgentUrlKey: 'cto' } },
        ...overrides,
      },
    },
  };
}

function sseFrames(body: unknown): Array<{ jsonrpc: string; id: unknown; result: Record<string, unknown> }> {
  assert.equal(typeof body, 'string');
  return (body as string)
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      assert.ok(frame.startsWith('data: '), `SSE frame: ${frame}`);
      return JSON.parse(frame.slice('data: '.length));
    });
}

// ── auth fail-closed ──────────────────────────────────────────────────────────

test('PIN auth: missing token ⇒ 401; nothing loaded, assembled or sent', async () => {
  const { deps, sent, calls } = makeDeps();
  const res = await handleHarnessChat({ authorization: null, body: chatBody(), deps });
  assert.equal(res.status, 401);
  assert.equal(calls.loadAgent, 0);
  assert.equal(calls.assemble, 0);
  assert.equal(sent.length, 0);
});

test('PIN auth: invalid/expired token ⇒ 401 even for a fully advertised bind; DM never sent', async () => {
  for (const method of ['message/send', 'message/stream']) {
    const { deps, sent, calls } = makeDeps({ authenticated: false });
    const res = await handleHarnessChat({ authorization: 'Bearer bad', body: chatBody(method), deps });
    assert.equal(res.status, 401, method);
    assert.equal(calls.assemble, 0);
    assert.equal(sent.length, 0);
  }
});

// ── unsupported ⇒ clear refuse ────────────────────────────────────────────────

test('PIN unsupported: in-product agent (no bind) ⇒ 409 chat_not_supported, no gate, no send', async () => {
  const { deps, sent, calls } = makeDeps({ adapterConfig: null });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'chat_not_supported');
  assert.match((res.body as { message: string }).message, /sendToAgent/);
  assert.equal(calls.assemble, 0);
  assert.equal(sent.length, 0);
});

test('PIN unsupported: Hermes/OpenCode bind WITHOUT chat ⇒ 409 (nothing advertised = refuse)', async () => {
  for (const bind of [HERMES_HTTP, OPENCODE_HTTP, { ...HERMES_HTTP, chat: {} }, { ...HERMES_HTTP, chat: { sync: false, stream: false } }]) {
    const { deps, sent } = makeDeps({ adapterConfig: { ...bind } });
    const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
    assert.equal(res.status, 409, JSON.stringify(bind));
    assert.equal((res.body as { error: string }).error, 'chat_not_supported');
    assert.equal(sent.length, 0);
  }
});

test('PIN unsupported: malformed bind (typo key / bad chat flag) fails closed ⇒ 409', async () => {
  for (const bind of [
    { ...HERMES_HTTP, chat: { sync: true }, harnessBaseurl: 'http://x' },
    { ...HERMES_HTTP, chat: { sync: 'yes' } },
    { ...HERMES_HTTP, chat: { sync: true, steam: true } },
    { ...OPENCODE_HTTP, mode: 'remote', chat: { sync: true } }, // remote without harnessBaseUrl/apiToken
  ]) {
    const { deps, sent } = makeDeps({ adapterConfig: bind as Record<string, unknown> });
    const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
    assert.equal(res.status, 409, JSON.stringify(bind));
    assert.equal(sent.length, 0);
  }
});

test('PIN stream fail-closed: sync-only bind refuses message/stream with 409 chat_stream_not_supported', async () => {
  const { deps, sent, calls } = makeDeps({ adapterConfig: { ...OPENCODE_HTTP, chat: { sync: true } } });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/stream'), deps });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'chat_stream_not_supported');
  assert.equal(calls.assemble, 0);
  assert.equal(sent.length, 0);
});

test('PIN: stream-only bind refuses message/send with 409 chat_sync_not_supported', async () => {
  const { deps, sent } = makeDeps({ adapterConfig: { ...HERMES_HTTP, chat: { stream: true } } });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/send'), deps });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'chat_sync_not_supported');
  assert.equal(sent.length, 0);
});

test('unknown JSON-RPC method ⇒ 400 unsupported_method; bad bodies ⇒ 400; nothing sent', async () => {
  const { deps, sent } = makeDeps();
  const bad = await handleHarnessChat({ authorization: AUTH, body: chatBody('tasks/get'), deps });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { error: string }).error, 'unsupported_method');
  for (const body of [
    undefined,
    { jsonrpc: '1.0', id: 1, method: 'message/send', params: chatBody().params },
    chatBody('message/send', { parts: [] }),
    chatBody('message/send', { parts: [{ kind: 'text', text: '   ' }] }),
    chatBody('message/send', { parts: [{ kind: 'text', text: 'x'.repeat(8001) }] }),
    chatBody('message/send', { metadata: { tourbillon: { toAgentUrlKey: 'cto', sudo: true } } }),
  ]) {
    const res = await handleHarnessChat({ authorization: AUTH, body, deps });
    assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 120));
  }
  assert.equal(sent.length, 0);
});

test('no peer recipient ⇒ 400 chat_recipient_required (board chat is not a harness API)', async () => {
  const { deps, sent } = makeDeps();
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/send', { metadata: {} }), deps });
  assert.equal(res.status, 400);
  assert.equal((res.body as { error: string }).error, 'chat_recipient_required');
  assert.equal(sent.length, 0);
});

// ── capability deny ───────────────────────────────────────────────────────────

test('PIN gate: sendToAgent absent from assembleAgentTools ⇒ 403 chat_not_permitted, DM NEVER executes', async () => {
  for (const method of ['message/send', 'message/stream']) {
    const { deps, sent, calls } = makeDeps({ toolKeys: ['getIdentityTool', 'getMessagesTool'] });
    const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(method), deps });
    assert.equal(res.status, 403, method);
    assert.equal((res.body as { error: string }).error, 'chat_not_permitted');
    assert.equal(calls.assemble, 1, 'the gate is the real assembler');
    assert.equal(sent.length, 0, 'denied DM must not execute');
  }
});

test('PIN gate: assembler blow-up ⇒ 500 capability_gate_failed (fail closed, nothing sent)', async () => {
  const { deps, sent } = makeDeps({ assembleThrows: true });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
  assert.equal(res.status, 500);
  assert.equal((res.body as { error: string }).error, 'capability_gate_failed');
  assert.equal(sent.length, 0);
});

// ── 501 gone for supported binds ──────────────────────────────────────────────

test('Hermes sync: message/send ⇒ 200 JSON-RPC agent Message; DM sent via the gated tool with run token', async () => {
  const { deps, sent } = makeDeps();
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/send'), deps });
  assert.equal(res.status, 200);
  assert.notEqual(res.status, 501);
  const body = res.body as { jsonrpc: string; id: string; result: Record<string, unknown> };
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 'req-1');
  assert.equal(body.result.kind, 'message');
  assert.equal(body.result.role, 'agent');
  assert.equal(body.result.messageId, 'msg-fixed');
  assert.equal(body.result.contextId, 'run-1');
  assert.deepEqual((body.result.parts as unknown[])[1], { kind: 'data', data: { tool: 'sendToAgent', result: { id: 'mail-1', ok: true } } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'sendToAgentTool');
  assert.deepEqual(sent[0].args, { toAgentUrlKey: 'cto', body: 'Can you review PR 12?' });
  assert.equal(sent[0].apiKey, 'pm_run_token_abc');
  assert.equal(sent[0].runId, 'run-1');
  assert.equal(sent[0].agentId, 'agent-1');
});

test('Hermes stream: message/stream ⇒ 200 SSE (working → Message → final completed)', async () => {
  const { deps, sent } = makeDeps();
  const res = await handleHarnessChat({
    authorization: AUTH,
    body: chatBody('message/stream', { metadata: { tourbillon: { toAgentId: 'agent-2', inReplyTo: 'mail-0' } } }),
    deps,
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType ?? '', /^text\/event-stream/);
  const frames = sseFrames(res.body);
  assert.equal(frames.length, 3);
  for (const f of frames) {
    assert.equal(f.jsonrpc, '2.0');
    assert.equal(f.id, 'req-1');
  }
  assert.equal(frames[0].result.kind, 'status-update');
  assert.deepEqual(frames[0].result.status, { state: 'working' });
  assert.equal(frames[0].result.final, false);
  assert.equal(frames[1].result.kind, 'message');
  assert.equal(frames[2].result.kind, 'status-update');
  assert.equal((frames[2].result.status as { state: string }).state, 'completed');
  assert.equal(frames[2].result.final, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, { toAgentId: 'agent-2', body: 'Can you review PR 12?', inReplyTo: 'mail-0' });
});

test('OpenCode sync: message/send ⇒ 200 through the same gate', async () => {
  const { deps, sent } = makeDeps({ adapterConfig: { ...OPENCODE_HTTP, chat: { sync: true } } });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/send'), deps });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apiKey, 'pm_run_token_abc');
});

test('DM tool found by tool id when keyed without the Tool suffix', async () => {
  const { deps, sent } = makeDeps({ toolKeys: ['sendToAgent'] });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
});

test('delivery failure (tool returned error / threw) ⇒ sync 502 chat_delivery_failed; stream final failed', async () => {
  const errRes = makeDeps({ dmResult: { error: 'HTTP 404', message: 'agent not found' } });
  const sync = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps: errRes.deps });
  assert.equal(sync.status, 502);
  assert.equal((sync.body as { error: { message: string } }).error.message, 'chat_delivery_failed');

  const thrown = makeDeps({ dmThrows: true });
  const stream = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/stream'), deps: thrown.deps });
  assert.equal(stream.status, 200);
  const frames = sseFrames(stream.body);
  assert.equal((frames[2].result.status as { state: string }).state, 'failed');
  assert.equal(frames[2].result.final, true);
});

test('resolveHarnessChatCapability: advertised legs only', () => {
  const agent = (adapterConfig: unknown) => ({ id: 'a', companyId: 'c', adapterConfig });
  assert.equal(resolveHarnessChatCapability(agent(undefined)), null);
  assert.equal(resolveHarnessChatCapability(agent({ harness: 'other', chat: { sync: true } })), null);
  assert.deepEqual(resolveHarnessChatCapability(agent({ ...HERMES_HTTP, chat: { stream: true } })), {
    harness: 'hermes',
    sync: false,
    stream: true,
  });
  assert.deepEqual(resolveHarnessChatCapability(agent({ ...OPENCODE_HTTP, chat: { sync: true } })), {
    harness: 'opencode',
    sync: true,
    stream: false,
  });
});

// ── S327-S3: combined-failure ordering ────────────────────────────────────────

test('PIN S327-S3: unadvertised leg ⇒ 409 even when text AND recipient are also bad (leg wins over 400s)', async () => {
  const { deps, sent, calls } = makeDeps({
    adapterConfig: { ...OPENCODE_HTTP, chat: { sync: true } },
    toolKeys: ['getIdentityTool'], // DM not granted either
  });
  const res = await handleHarnessChat({
    authorization: AUTH,
    body: chatBody('message/stream', { parts: [{ kind: 'text', text: '  ' }], metadata: {} }),
    deps,
  });
  assert.equal(res.status, 409);
  assert.equal((res.body as { error: string }).error, 'chat_stream_not_supported');
  assert.equal(calls.assemble, 0);
  assert.equal(sent.length, 0);
});

test('PIN S327-S3: every 400 fires before the 403 gate — DM not granted, assembly never runs', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['bad method', chatBody('tasks/get', { metadata: {} }), 'unsupported_method'],
    ['empty text', chatBody('message/send', { parts: [{ kind: 'text', text: ' ' }] }), 'invalid_request'],
    ['over-long text', chatBody('message/send', { parts: [{ kind: 'text', text: 'x'.repeat(8001) }] }), 'invalid_request'],
    ['no recipient', chatBody('message/send', { metadata: {} }), 'chat_recipient_required'],
    ['invalid JSON (undefined body)', undefined, 'invalid_request'],
  ];
  for (const [label, body, error] of cases) {
    const { deps, sent, calls } = makeDeps({ toolKeys: ['getIdentityTool', 'getMessagesTool'] });
    const res = await handleHarnessChat({ authorization: AUTH, body, deps });
    assert.equal(res.status, 400, label);
    assert.equal((res.body as { error: string }).error, error, label);
    assert.equal(calls.assemble, 0, `${label}: gate must not run before the 400`);
    assert.equal(sent.length, 0, label);
  }
});

test('PIN S327-S3: text 400 precedes recipient 400 (empty text + no recipient ⇒ invalid_request)', async () => {
  const { deps, sent } = makeDeps();
  const res = await handleHarnessChat({
    authorization: AUTH,
    body: chatBody('message/send', { parts: [{ kind: 'text', text: '' }], metadata: {} }),
    deps,
  });
  assert.equal(res.status, 400);
  assert.equal((res.body as { error: string }).error, 'invalid_request');
  assert.equal(sent.length, 0);
});

test('PIN S327-S3: valid request + DM not granted ⇒ 403 only after all 400 checks pass', async () => {
  const { deps, sent, calls } = makeDeps({ toolKeys: ['getIdentityTool'] });
  const res = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
  assert.equal(res.status, 403);
  assert.equal((res.body as { error: string }).error, 'chat_not_permitted');
  assert.equal(calls.assemble, 1);
  assert.equal(sent.length, 0);
});

// ── S327-S4: stream delivery failure contract ─────────────────────────────────

test('PIN S327-S4: stream delivery failure (tool returned error) ⇒ HTTP 200 + final failed; sync ⇒ 502', async () => {
  const { deps } = makeDeps({ dmResult: { error: 'HTTP 404', message: 'agent not found' } });
  const stream = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/stream'), deps });
  assert.equal(stream.status, 200);
  const frames = sseFrames(stream.body);
  assert.equal(frames.length, 3);
  assert.equal((frames[2].result.status as { state: string }).state, 'failed');
  assert.equal(frames[2].result.final, true);
  assert.match(JSON.stringify(frames[1].result), /Delivery to cto failed: HTTP 404: agent not found/);
  const sync = await handleHarnessChat({ authorization: AUTH, body: chatBody('message/send'), deps });
  assert.equal(sync.status, 502);
});

// ── S327-S3: route glue (callback-http.ts) ────────────────────────────────────

function chatRequest(body: string, authorization?: string) {
  return new Request('http://tourbillon.test/api/harness/callback/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body,
  });
}

test('PIN S327-S3 route: invalid JSON ⇒ 401 without/bad token (auth first), 400 only after auth', async () => {
  for (const auth of [undefined, 'Bearer bad']) {
    const { deps, calls } = makeDeps({ authenticated: auth ? false : undefined });
    const res = await harnessChatPost(chatRequest('{not json', auth), deps);
    assert.equal(res.status, 401, String(auth));
    assert.equal(calls.loadAgent, 0);
  }
  const { deps, sent, calls } = makeDeps();
  const res = await harnessChatPost(chatRequest('{not json', AUTH), deps);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_request');
  assert.equal(calls.authenticate, 1, 'auth ran before the 400');
  assert.equal(calls.assemble, 0);
  assert.equal(sent.length, 0);
});

test('PIN S327-S3 route: stream 200 ⇒ text/event-stream + no-cache/no-transform + X-Accel-Buffering: no', async () => {
  const { deps } = makeDeps();
  const res = await harnessChatPost(chatRequest(JSON.stringify(chatBody('message/stream')), AUTH), deps);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const frames = sseFrames(await res.text());
  assert.equal((frames[2].result.status as { state: string }).state, 'completed');

  const sync = await harnessChatPost(chatRequest(JSON.stringify(chatBody('message/send')), AUTH), makeDeps().deps);
  assert.equal(sync.status, 200);
  assert.match(sync.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(sync.headers.get('x-accel-buffering'), null);
});

// ── S331-2 (#331): ambiguous DM id — chat answers the SAME 409 as tools/call ──────────────
test('PIN S331-2: two gated tools collide on sendToAgent ⇒ chat and tools/call both answer the SAME 409 ambiguous_tool, DM NEVER executes', async () => {
  const ran: string[] = [];
  const colliding = (label: string) => ({
    id: 'sendToAgent',
    execute: async () => {
      ran.push(label);
      return { ok: true, label };
    },
  });
  const { deps, sent } = makeDeps();
  deps.assembleTools = async () => ({
    mcp_one_dm: colliding('one'),
    mcp_two_dm: colliding('two'),
  });

  const chat = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps });
  // Pre-S331-2 this was 403 chat_not_permitted (findGatedTool folded ambiguous into absent).
  assert.equal(chat.status, 409, 'ambiguous DM id must be 409 on the chat path, not 403');
  const call = await handleHarnessToolCall({ authorization: AUTH, body: { tool: 'sendToAgent', args: {} }, deps });
  assert.equal(call.status, 409);

  const chatOut = chat.body as Record<string, unknown>;
  const callOut = call.body as Record<string, unknown>;
  assert.equal(chatOut.error, 'ambiguous_tool');
  assert.equal(chatOut.tool, 'sendToAgent');
  assert.deepEqual(chatOut.candidates, ['mcp_one_dm', 'mcp_two_dm']);
  // SAME status AND body shape on both paths (same tool name ⇒ identical bodies).
  assert.deepEqual(Object.keys(chatOut).sort(), Object.keys(callOut).sort());
  assert.deepEqual(chatOut, callOut);
  assert.deepEqual(ran, [], 'neither colliding DM tool executes on either path');
  assert.deepEqual(sent, [], 'makeDeps DM never ran');

  // Fail-closed parity stays: an absent tool is STILL 403 chat_not_permitted (not 409).
  const { deps: absentDeps } = makeDeps({ toolKeys: ['getIdentityTool'] });
  const absent = await handleHarnessChat({ authorization: AUTH, body: chatBody(), deps: absentDeps });
  assert.equal(absent.status, 403);
  assert.equal((absent.body as { error: string }).error, 'chat_not_permitted');
});
