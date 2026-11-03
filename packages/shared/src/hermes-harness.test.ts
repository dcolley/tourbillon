import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HERMES_CALLBACK_PATHS,
  HERMES_DEFAULT_CALLBACK_ORIGIN,
  HERMES_HEARTBEAT_KIND,
  HERMES_REMOTE_API_TOKEN_MIN_LENGTH,
  HERMES_SKILL_INSTALL_MD,
  HermesHarnessConfigError,
  buildHermesA2aMessageSendRequest,
  buildHermesHeartbeatEnvelope,
  deriveHermesCallbackBaseUrl,
  hermesA2aFinishReasonFromTask,
  isHermesHarnessBind,
  parseHermesHarnessBind,
} from './hermes-harness';

const REMOTE_TOKEN = 'a'.repeat(HERMES_REMOTE_API_TOKEN_MIN_LENGTH);

test('isHermesHarnessBind discriminates without touching anything else', () => {
  assert.equal(isHermesHarnessBind({}), false);
  assert.equal(isHermesHarnessBind({ provider: 'lmstudio' }), false); // in-product harness_local
  assert.equal(isHermesHarnessBind(null), false);
  assert.equal(isHermesHarnessBind(['harness']), false);
  assert.equal(isHermesHarnessBind({ harness: 'opencode' }), false); // OpenCode pack later
  assert.equal(isHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'hermes' }), true);
});

test('parse: valid local command bind', () => {
  const bind = parseHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'hermes run --in -' });
  assert.equal(bind.mode, 'local');
  assert.equal(bind.command, 'hermes run --in -');
});

test('parse: valid local loopback baseUrl bind (command optional)', () => {
  const bind = parseHermesHarnessBind({
    harness: 'hermes',
    mode: 'local',
    localBaseUrl: 'http://127.0.0.1:9900',
  });
  assert.equal(bind.localBaseUrl, 'http://127.0.0.1:9900');
});

test('parse: local bind with neither command nor localBaseUrl throws', () => {
  assert.throws(
    () => parseHermesHarnessBind({ harness: 'hermes', mode: 'local' }),
    (err: unknown) =>
      err instanceof HermesHarnessConfigError && /command|localBaseUrl/.test(err.message),
  );
});

test('parse: local baseUrl must be loopback (no sneaky remote under "local")', () => {
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'local',
        localBaseUrl: 'http://203.0.113.9:9900',
      }),
    HermesHarnessConfigError,
  );
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'local',
        localBaseUrl: 'http://evil.example.com',
      }),
    HermesHarnessConfigError,
  );
  // localhost and ::1 spellings are fine
  assert.doesNotThrow(() =>
    parseHermesHarnessBind({ harness: 'hermes', mode: 'local', localBaseUrl: 'http://localhost:9900' }),
  );
  assert.doesNotThrow(() =>
    parseHermesHarnessBind({ harness: 'hermes', mode: 'local', localBaseUrl: 'http://[::1]:9900' }),
  );
});

test('parse: remote bind requires harnessBaseUrl and a real apiToken', () => {
  assert.throws(
    () => parseHermesHarnessBind({ harness: 'hermes', mode: 'remote' }),
    /harnessBaseUrl/,
  );
  assert.throws(
    () => parseHermesHarnessBind({ harness: 'hermes', mode: 'remote', harnessBaseUrl: 'http://100.105.50.60:9900' }),
    /apiToken/,
  );
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'remote',
        harnessBaseUrl: 'http://100.105.50.60:9900',
        apiToken: 'short',
      }),
    /apiToken/,
  );
  const ok = parseHermesHarnessBind({
    harness: 'hermes',
    mode: 'remote',
    harnessBaseUrl: 'http://100.105.50.60:9900',
    apiToken: REMOTE_TOKEN,
  });
  assert.equal(ok.harnessBaseUrl, 'http://100.105.50.60:9900');
});

// S316-S2 (Refs #316, from the #316 gate): the coarse rejections above ('short',
// 203.0.113.9) survive off-by-one / hostname-matching mutants. These PINs bind
// the rules exactly at the boundary — measured RED against mutants that relax
// the length by one or loosen the loopback hostname match (PR body evidence).
test('S316-S2 PIN: remote apiToken boundary is exactly HERMES_REMOTE_API_TOKEN_MIN_LENGTH = 16', () => {
  assert.equal(HERMES_REMOTE_API_TOKEN_MIN_LENGTH, 16);
  const base = {
    harness: 'hermes' as const,
    mode: 'remote' as const,
    harnessBaseUrl: 'http://100.105.50.60:9900',
  };
  // exactly the minimum passes
  assert.equal(parseHermesHarnessBind({ ...base, apiToken: 'k'.repeat(16) }).apiToken, 'k'.repeat(16));
  // one below the minimum fails
  assert.throws(() => parseHermesHarnessBind({ ...base, apiToken: 'k'.repeat(15) }), /apiToken/);
  // whitespace does not smuggle a 16-char token (the rule measures trim().length)
  assert.throws(() => parseHermesHarnessBind({ ...base, apiToken: `${'k'.repeat(15)} ` }), /apiToken/);
  // the length rule is REMOTE-only: a local bind may carry a short key-gated token
  assert.doesNotThrow(() =>
    parseHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'hermes', apiToken: 'short' }),
  );
});

test('S316-S2 PIN: localBaseUrl loopback accepted/rejected hostname matrix', () => {
  // accepted: the documented loopback set (127.0.0.1 / localhost / ::1 / 127.x)
  for (const okUrl of [
    'http://127.0.0.1:9900',
    'http://localhost:9900',
    'http://[::1]:9900',
    'http://127.5.5.5:9900',
    'http://LOCALHOST:9900',
  ]) {
    assert.doesNotThrow(
      () => parseHermesHarnessBind({ harness: 'hermes', mode: 'local', localBaseUrl: okUrl }),
      `must accept loopback localBaseUrl ${okUrl}`,
    );
  }
  // rejected: anything that only LOOKS loopback or is plainly remote —
  // localhost.evil.com kills loosening `h === 'localhost'` to includes/startsWith.
  for (const badUrl of [
    'http://10.0.0.5:4096',
    'http://192.168.1.1:9900',
    'http://203.0.113.9:9900',
    'http://hermes.internal:9900',
    'http://localhost.evil.com:9900',
  ]) {
    assert.throws(
      () => parseHermesHarnessBind({ harness: 'hermes', mode: 'local', localBaseUrl: badUrl }),
      HermesHarnessConfigError,
      `must reject non-loopback localBaseUrl ${badUrl}`,
    );
  }
});

test('parse: strict on unknown keys, rejects credential/query/hash URLs', () => {
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'local',
        command: 'hermes',
        harnessBaseurl: 'http://localhost:1', // typo caught by .strict()
      }),
    HermesHarnessConfigError,
  );
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'local',
        command: 'hermes',
        callbackBaseUrl: 'http://user:pass@127.0.0.1:3002',
      }),
    HermesHarnessConfigError,
  );
  assert.throws(
    () =>
      parseHermesHarnessBind({
        harness: 'hermes',
        mode: 'local',
        command: 'hermes',
        callbackBaseUrl: 'ftp://127.0.0.1',
      }),
    HermesHarnessConfigError,
  );
});

test('deriveHermesCallbackBaseUrl: privacy default is loopback, localhost normalised', () => {
  assert.equal(deriveHermesCallbackBaseUrl(undefined, 'http://localhost:3002'), 'http://127.0.0.1:3002');
  assert.equal(deriveHermesCallbackBaseUrl(undefined, 'http://127.0.0.1:3002'), 'http://127.0.0.1:3002');
  // unset/unparseable INTERNAL_API_URL → loopback fallback (never a silent public default)
  assert.equal(deriveHermesCallbackBaseUrl(undefined, undefined), HERMES_DEFAULT_CALLBACK_ORIGIN);
  assert.equal(deriveHermesCallbackBaseUrl(undefined, 'not a url'), HERMES_DEFAULT_CALLBACK_ORIGIN);
  // explicit override wins (LAN/Tailscale reachability for remote harnesses — operator opt-in)
  assert.equal(
    deriveHermesCallbackBaseUrl('http://100.105.50.7:3002', 'http://localhost:3002'),
    'http://100.105.50.7:3002',
  );
});

function baseEnvelopeInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    companyId: 'company-1',
    wakeReason: 'timer',
    prompt: 'Do the work.',
    sessionToken: 'pm_run_abc',
    callbackBaseUrl: 'http://127.0.0.1:3002',
    ...overrides,
  };
}

test('envelope: EVERY heartbeat stamps callback.baseUrl + sessionToken + endpoints', () => {
  const env = buildHermesHeartbeatEnvelope(baseEnvelopeInput({ taskId: 'issue-9' }));
  assert.equal(env.kind, HERMES_HEARTBEAT_KIND);
  assert.equal(env.callback.baseUrl, 'http://127.0.0.1:3002');
  assert.equal(env.callback.sessionToken, 'pm_run_abc');
  assert.deepEqual(env.callback.endpoints, HERMES_CALLBACK_PATHS);
  assert.equal(env.taskId, 'issue-9');
  assert.equal(env.skillInstall, HERMES_SKILL_INSTALL_MD); // bundled blob by default
});

test('envelope: missing callbackUrl fails closed (never dispatch a homeless heartbeat)', () => {
  assert.throws(
    () => buildHermesHeartbeatEnvelope(baseEnvelopeInput({ callbackBaseUrl: '' })),
    HermesHarnessConfigError,
  );
  assert.throws(
    () => buildHermesHeartbeatEnvelope(baseEnvelopeInput({ callbackBaseUrl: undefined as any })),
    /callback\.baseUrl/,
  );
});

test('envelope: missing session token fails closed', () => {
  assert.throws(
    () => buildHermesHeartbeatEnvelope(baseEnvelopeInput({ sessionToken: '   ' })),
    /callback\.sessionToken|sessionToken/,
  );
});

test('envelope: custom skillInstall blob overrides the bundled skill', () => {
  const env = buildHermesHeartbeatEnvelope(baseEnvelopeInput({ skillInstall: 'CUSTOM SKILL' }));
  assert.equal(env.skillInstall, 'CUSTOM SKILL');
});

test('a2a request: message/send carries prompt in text part and envelope in metadata', () => {
  const env = buildHermesHeartbeatEnvelope(baseEnvelopeInput());
  const req = buildHermesA2aMessageSendRequest(env, 'msg-1');
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.method, 'message/send');
  assert.equal(req.id, 'run-1');
  assert.equal(req.params.message.parts[0].text, 'Do the work.');
  assert.equal(req.params.message.metadata.tourbillon.callback.sessionToken, 'pm_run_abc');
  assert.equal(req.params.message.role, 'user');
});

test('a2a finish mapping: only completed is success; anything else errors loudly', () => {
  assert.equal(hermesA2aFinishReasonFromTask({ status: { state: 'completed' } }), 'complete');
  assert.equal(hermesA2aFinishReasonFromTask({ status: { state: 'failed' } }), 'error');
  assert.equal(hermesA2aFinishReasonFromTask({ status: { state: 'rejected' } }), 'error');
  // non-terminal states must NOT silently pass (push-notification resume is not in this slice)
  assert.equal(hermesA2aFinishReasonFromTask({ status: { state: 'working' } }), 'error');
  assert.equal(hermesA2aFinishReasonFromTask({}), 'error');
  assert.equal(hermesA2aFinishReasonFromTask(null), 'error');
});

test('skill blob teaches the callback contract and never embeds a token', () => {
  assert.match(HERMES_SKILL_INSTALL_MD, /tourbillon\.heartbeat/);
  assert.match(HERMES_SKILL_INSTALL_MD, /tools\/call|toolsCall/);
  assert.match(HERMES_SKILL_INSTALL_MD, /403/);
  assert.ok(!HERMES_SKILL_INSTALL_MD.includes('pm_run_abc'));
});
