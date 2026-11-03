/**
 * #281 opencode-harness (shared) pins:
 *  - Bind parsing is STRICT: local needs command/localBaseUrl; remote needs harnessBaseUrl +
 *    apiToken >= 16 chars; unknown keys are REJECTED (typo'd keys must not silently disable
 *    the remote requirement); malformed → OpencodeHarnessConfigError, never a silent fallback.
 *  - Envelope building FAILS CLOSED on missing sessionToken / callbackBaseUrl.
 *  - Callback derivation: localhost → 127.0.0.1; explicit callbackBaseUrl wins; garbage →
 *    loopback:3002.
 *  - Measured-API helpers: modelId split, prompt body carries the envelope JSON, session
 *    create body is machine-readable, finish mapping only "stop" passes, tokens extracted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENCODE_DEFAULT_CALLBACK_ORIGIN,
  OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH,
  OPENCODE_SKILL_INSTALL_MD,
  OpencodeHarnessConfigError,
  buildOpencodeHeartbeatEnvelope,
  buildOpencodePromptBody,
  buildOpencodeSessionCreateBody,
  deriveOpencodeCallbackBaseUrl,
  isOpencodeHarnessBind,
  opencodeFinishReasonFromPrompt,
  opencodeModelFromModelId,
  opencodeTokensFromPrompt,
  parseOpencodeHarnessBind,
} from './opencode-harness';

const REMOTE_TOKEN = 'tok-0123456789abcdef0';

const envelopeInput = () => ({
  runId: 'run-1',
  agentId: 'agent-1',
  companyId: 'company-1',
  wakeReason: 'timer',
  taskId: 'issue-1',
  prompt: 'WAKE PROMPT',
  sessionToken: 'pm_run_session_token',
  callbackBaseUrl: 'http://127.0.0.1:3002',
});

test('bind: local with command parses; harness key discriminates', () => {
  const bind = parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', command: 'opencode run' });
  assert.equal(bind.mode, 'local');
  assert.equal(bind.command, 'opencode run');
  assert.ok(isOpencodeHarnessBind({ harness: 'opencode' }));
  assert.ok(!isOpencodeHarnessBind({ harness: 'hermes' }));
  assert.ok(!isOpencodeHarnessBind(null));
  assert.ok(!isOpencodeHarnessBind(['harness']));
});

test('bind: local without command AND localBaseUrl is rejected', () => {
  assert.throws(
    () => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local' }),
    (err: unknown) =>
      err instanceof OpencodeHarnessConfigError && /local OpenCode bind/.test(err.message),
  );
});

test('bind: local localBaseUrl must be loopback', () => {
  assert.throws(
    () => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', localBaseUrl: 'http://10.0.0.5:4096' }),
    OpencodeHarnessConfigError,
  );
  const bind = parseOpencodeHarnessBind({
    harness: 'opencode',
    mode: 'local',
    localBaseUrl: 'http://localhost:4096/',
  });
  assert.equal(bind.localBaseUrl, 'http://localhost:4096', 'trailing slash normalised');
});

test('bind: remote requires harnessBaseUrl and a >=16-char apiToken', () => {
  assert.throws(
    () => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'remote' }),
    (err: unknown) => err instanceof OpencodeHarnessConfigError && /harnessBaseUrl/.test(err.message),
  );
  assert.throws(
    () =>
      parseOpencodeHarnessBind({
        harness: 'opencode',
        mode: 'remote',
        harnessBaseUrl: 'http://100.105.50.60:4096',
        apiToken: 'short-token',
      }),
    (err: unknown) => err instanceof OpencodeHarnessConfigError && /apiToken/.test(err.message),
  );
  const bind = parseOpencodeHarnessBind({
    harness: 'opencode',
    mode: 'remote',
    harnessBaseUrl: 'http://100.105.50.60:4096',
    apiToken: REMOTE_TOKEN,
  });
  assert.equal(bind.mode, 'remote');
});

// S316-S2 (Refs #316, from the #316 gate): same bind-rule PINs as the Hermes
// suite — the coarse rejections above ('short-token' = 11, 10.0.0.5) survive
// off-by-one / hostname-matching mutants; these bind the rules exactly at the
// boundary (measured RED, PR body evidence).
test('S316-S2 PIN: remote apiToken boundary is exactly OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH = 16', () => {
  assert.equal(OPENCODE_REMOTE_API_TOKEN_MIN_LENGTH, 16);
  const base = {
    harness: 'opencode' as const,
    mode: 'remote' as const,
    harnessBaseUrl: 'http://100.105.50.60:4096',
  };
  // exactly the minimum passes
  assert.equal(parseOpencodeHarnessBind({ ...base, apiToken: 'k'.repeat(16) }).apiToken, 'k'.repeat(16));
  // one below the minimum fails
  assert.throws(() => parseOpencodeHarnessBind({ ...base, apiToken: 'k'.repeat(15) }), /apiToken/);
  // whitespace does not smuggle a 16-char token (the rule measures trim().length)
  assert.throws(() => parseOpencodeHarnessBind({ ...base, apiToken: `${'k'.repeat(15)} ` }), /apiToken/);
  // the length rule is REMOTE-only: a local bind may carry a short key-gated token
  assert.doesNotThrow(() =>
    parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', command: 'opencode run', apiToken: 'short' }),
  );
});

test('S316-S2 PIN: localBaseUrl loopback accepted/rejected hostname matrix', () => {
  // accepted: the documented loopback set (127.0.0.1 / localhost / ::1 / 127.x)
  for (const okUrl of [
    'http://127.0.0.1:4096',
    'http://localhost:4096',
    'http://[::1]:4096',
    'http://127.5.5.5:4096',
    'http://LOCALHOST:4096',
  ]) {
    assert.doesNotThrow(
      () => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', localBaseUrl: okUrl }),
      `must accept loopback localBaseUrl ${okUrl}`,
    );
  }
  // rejected: anything that only LOOKS loopback or is plainly remote —
  // localhost.evil.com kills loosening `h === 'localhost'` to includes/startsWith.
  for (const badUrl of [
    'http://10.0.0.5:4096',
    'http://192.168.1.1:4096',
    'http://203.0.113.9:4096',
    'http://opencode.internal:4096',
    'http://localhost.evil.com:4096',
  ]) {
    assert.throws(
      () => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', localBaseUrl: badUrl }),
      OpencodeHarnessConfigError,
      `must reject non-loopback localBaseUrl ${badUrl}`,
    );
  }
});

test('bind: STRICT — unknown keys are rejected (a typo must not disable the remote checks)', () => {
  assert.throws(
    () =>
      parseOpencodeHarnessBind({
        harness: 'opencode',
        mode: 'remote',
        harnessBaseUrl: 'http://100.105.50.60:4096',
        apiToken: REMOTE_TOKEN,
        remoteUrl: 'http://evil.example', // typo'd key
      }),
    OpencodeHarnessConfigError,
  );
});

test('bind: URLs with credentials/query are rejected', () => {
  assert.throws(
    () =>
      parseOpencodeHarnessBind({
        harness: 'opencode',
        mode: 'remote',
        harnessBaseUrl: 'http://user:' + 'pw' + '@100.105.50.60:4096',
        apiToken: REMOTE_TOKEN,
      }),
    OpencodeHarnessConfigError,
  );
});

test('PIN: envelope building fails closed without session token', () => {
  const input = envelopeInput();
  assert.throws(
    () => buildOpencodeHeartbeatEnvelope({ ...input, sessionToken: '' }),
    (err: unknown) =>
      err instanceof OpencodeHarnessConfigError && /callback\.sessionToken/.test(err.message),
  );
});

test('PIN: envelope building fails closed without callback origin', () => {
  const input = envelopeInput();
  assert.throws(
    () => buildOpencodeHeartbeatEnvelope({ ...input, callbackBaseUrl: '   ' }),
    (err: unknown) => err instanceof OpencodeHarnessConfigError && /callback\.baseUrl/.test(err.message),
  );
});

test('envelope: complete shape, shared kind/version, skill blob included', () => {
  const env = buildOpencodeHeartbeatEnvelope(envelopeInput());
  assert.equal(env.kind, 'tourbillon.heartbeat');
  assert.equal(env.version, 1);
  assert.equal(env.taskId, 'issue-1');
  assert.equal(env.callback.baseUrl, 'http://127.0.0.1:3002');
  assert.equal(env.callback.sessionToken, 'pm_run_session_token');
  assert.equal(env.callback.endpoints.toolsCall, '/api/harness/callback/tools/call');
  assert.ok(env.skillInstall.includes('name: tourbillon-agent'));
  const custom = buildOpencodeHeartbeatEnvelope({ ...envelopeInput(), skillInstall: 'CUSTOM' });
  assert.equal(custom.skillInstall, 'CUSTOM');
});

test('callback derivation: localhost→127.0.0.1, explicit wins, garbage→loopback default', () => {
  assert.equal(
    deriveOpencodeCallbackBaseUrl(undefined, 'http://localhost:3002'),
    'http://127.0.0.1:3002',
  );
  assert.equal(
    deriveOpencodeCallbackBaseUrl('https://tourbillon.internal.example:8443', 'http://localhost:3002'),
    'https://tourbillon.internal.example:8443',
  );
  assert.equal(deriveOpencodeCallbackBaseUrl(undefined, 'not-a-url'), OPENCODE_DEFAULT_CALLBACK_ORIGIN);
});

test('modelId split: provider/model → prompt model; anything else → undefined', () => {
  assert.deepEqual(opencodeModelFromModelId('lmstudio/qwen3.8-flash-next'), {
    providerID: 'lmstudio',
    modelID: 'qwen3.8-flash-next',
  });
  assert.deepEqual(opencodeModelFromModelId(' lmstudio/qwen '), {
    providerID: 'lmstudio',
    modelID: 'qwen',
  });
  assert.equal(opencodeModelFromModelId('qwen-no-provider'), undefined);
  assert.equal(opencodeModelFromModelId(''), undefined);
  assert.equal(opencodeModelFromModelId(null), undefined);
  assert.equal(opencodeModelFromModelId('provider/'), undefined);
});

test('prompt body: wake text + fenced envelope JSON + model when provided', () => {
  const env = buildOpencodeHeartbeatEnvelope(envelopeInput());
  const body = buildOpencodePromptBody(env, 'lmstudio/qwen3.8-flash-next');
  assert.deepEqual(body.model, { providerID: 'lmstudio', modelID: 'qwen3.8-flash-next' });
  assert.equal(body.parts.length, 1);
  assert.equal(body.parts[0].type, 'text');
  assert.ok(body.parts[0].text.startsWith('WAKE PROMPT'));
  const fence = body.parts[0].text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fence, 'envelope must ride as a fenced json block');
  const parsed = JSON.parse(fence![1]);
  assert.equal(parsed.kind, 'tourbillon.heartbeat');
  assert.equal(parsed.callback.sessionToken, 'pm_run_session_token');
  assert.deepEqual(buildOpencodePromptBody(env, 'no-slash').model, undefined);
});

test('session create body: machine-readable metadata.tourbillon, title set', () => {
  const env = buildOpencodeHeartbeatEnvelope(envelopeInput());
  const body = buildOpencodeSessionCreateBody(env);
  assert.ok(body.title.startsWith('tourbillon timer run-1'));
  assert.equal(body.metadata.tourbillon.runId, 'run-1');
  assert.equal(body.metadata.tourbillon.kind, 'tourbillon.heartbeat');
  assert.equal(body.metadata.tourbillon.taskId, 'issue-1');
});

test('finish mapping: ONLY info.finish==="stop" passes; everything else is error', () => {
  assert.equal(opencodeFinishReasonFromPrompt({ info: { finish: 'stop' } }), 'complete');
  assert.equal(opencodeFinishReasonFromPrompt({ info: { finish: 'error' } }), 'error');
  assert.equal(opencodeFinishReasonFromPrompt({ info: {} }), 'error');
  assert.equal(opencodeFinishReasonFromPrompt({}), 'error');
  assert.equal(opencodeFinishReasonFromPrompt(null), 'error');
});

test('token extraction: numbers pass through, junk → 0', () => {
  assert.deepEqual(opencodeTokensFromPrompt({ info: { tokens: { input: 8229, output: 4 } } }), {
    inputTokens: 8229,
    outputTokens: 4,
  });
  assert.deepEqual(opencodeTokensFromPrompt({ info: { tokens: { input: 'x' } } }), {
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.deepEqual(opencodeTokensFromPrompt(undefined), { inputTokens: 0, outputTokens: 0 });
});

test('skill blob: OpenCode SKILL.md shape teaches callback + token hygiene + checkout discipline', () => {
  assert.match(OPENCODE_SKILL_INSTALL_MD, /^---\nname: tourbillon-agent\n/);
  assert.match(OPENCODE_SKILL_INSTALL_MD, /toolsCall/);
  assert.match(OPENCODE_SKILL_INSTALL_MD, /tool_not_permitted/);
  assert.match(OPENCODE_SKILL_INSTALL_MD, /checkoutIssue/);
  assert.match(OPENCODE_SKILL_INSTALL_MD, /never print it/);
});
