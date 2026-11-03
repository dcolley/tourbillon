/**
 * #281 AC5 — harness chat wire pins (shared): bind `chat` capability is strict + optional on
 * BOTH harness binds; method map is exactly message/send→sync, message/stream→stream; the
 * bundled skills no longer advertise the 501 stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_CHAT_METHODS,
  buildHarnessChatReply,
  encodeHarnessChatSse,
  harnessChatCapabilitySchema,
  harnessChatModeForMethod,
  harnessChatText,
} from './harness-chat';
import { HERMES_SKILL_INSTALL_MD, parseHermesHarnessBind } from './hermes-harness';
import { OPENCODE_SKILL_INSTALL_MD, parseOpencodeHarnessBind } from './opencode-harness';

test('method map: only message/send (sync) and message/stream (stream)', () => {
  assert.deepEqual(HARNESS_CHAT_METHODS, { 'message/send': 'sync', 'message/stream': 'stream' });
  assert.equal(harnessChatModeForMethod('message/send'), 'sync');
  assert.equal(harnessChatModeForMethod('message/stream'), 'stream');
  for (const m of ['tasks/get', 'message/sendStream', 'toString', '__proto__', '']) {
    assert.equal(harnessChatModeForMethod(m), null, m);
  }
});

test('capability schema: strict booleans', () => {
  assert.ok(harnessChatCapabilitySchema.safeParse({ sync: true, stream: false }).success);
  assert.ok(harnessChatCapabilitySchema.safeParse({}).success);
  assert.equal(harnessChatCapabilitySchema.safeParse({ steam: true }).success, false);
  assert.equal(harnessChatCapabilitySchema.safeParse({ sync: 'true' }).success, false);
});

test('binds: chat is optional on Hermes and OpenCode; typo inside chat rejected', () => {
  const h = parseHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'hermes', chat: { sync: true, stream: true } });
  assert.deepEqual(h.chat, { sync: true, stream: true });
  assert.equal(parseHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'hermes' }).chat, undefined);
  const o = parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', command: 'opencode run', chat: { sync: true } });
  assert.deepEqual(o.chat, { sync: true });
  assert.throws(() => parseHermesHarnessBind({ harness: 'hermes', mode: 'local', command: 'h', chat: { synk: true } }));
  assert.throws(() => parseOpencodeHarnessBind({ harness: 'opencode', mode: 'local', command: 'o', chat: { stream: 1 } }));
});

test('text join ignores non-text parts; SSE frames are JSON-RPC responses', () => {
  assert.equal(harnessChatText([{ kind: 'text', text: 'a' }, { kind: 'data' }, { kind: 'text', text: 'b' }]), 'a\nb');
  const reply = buildHarnessChatReply({ messageId: 'm', contextId: 'r', text: 't', data: { x: 1 } });
  const sse = encodeHarnessChatSse(7, [reply]);
  assert.equal(sse, `data: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: reply })}\n\n`);
});

test('skills: 501 stub copy gone; chat documented as advertised-only + sendToAgent-gated', () => {
  for (const md of [HERMES_SKILL_INSTALL_MD, OPENCODE_SKILL_INSTALL_MD]) {
    assert.doesNotMatch(md, /chat_not_implemented|501/);
    assert.match(md, /message\/send/);
    assert.match(md, /chat_not_permitted/);
    assert.match(md, /chat_not_supported/);
  }
  assert.match(HERMES_SKILL_INSTALL_MD, /message\/stream/);
});
