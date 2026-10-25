/**
 * CTX-1: context meter estimate (pure): message token estimate, recall window, trim cap, levels,
 * labels and tooltip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextBudget, toolSchemaReserveForKind, CHAT_MEMORY_LAST_MESSAGES } from '@tourbillon/shared/context-budget';
import {
  CONTEXT_METER_ATTACHMENT_TOKENS,
  CONTEXT_METER_MESSAGE_OVERHEAD_TOKENS,
  buildThreadContextMeter,
  contextMeterLabel,
  contextMeterRatio,
  contextMeterTitle,
  estimateMessageTokens,
  formatTokenCount,
} from './context-meter';

const text = (n: number) => 'x'.repeat(n);
const msg = (chars: number, role = 'user') => ({ role, content: { format: 2, parts: [{ type: 'text', text: text(chars) }] } });
const O = CONTEXT_METER_MESSAGE_OVERHEAD_TOKENS;

describe('estimateMessageTokens', () => {
  it('counts text parts at ~4 chars per token plus per-message overhead', () => {
    assert.equal(estimateMessageTokens({ format: 2, parts: [{ type: 'text', text: text(400) }] }), 100 + O);
    assert.equal(estimateMessageTokens(text(8)), 2 + O);
    assert.equal(estimateMessageTokens({ format: 2, content: text(40) }), 10 + O);
  });
  it('skips reasoning, counts tool calls as JSON and attachments flat', () => {
    const tool = { state: 'result', toolName: 't', args: { q: 'abc' }, result: { ok: true } };
    const got = estimateMessageTokens({
      format: 2,
      parts: [
        { type: 'reasoning', reasoning: text(4000) },
        { type: 'step-start' },
        { type: 'tool-invocation', toolInvocation: tool },
        { type: 'file', data: text(100_000), mimeType: 'image/png' },
      ],
    });
    assert.equal(got, Math.ceil(JSON.stringify(tool).length / 4) + CONTEXT_METER_ATTACHMENT_TOKENS + O);
  });
  it('tolerates odd content', () => {
    assert.equal(estimateMessageTokens(null), O);
    assert.equal(estimateMessageTokens(undefined), O);
  });
});

describe('buildThreadContextMeter', () => {
  const budget = resolveContextBudget({ maxContextTokens: 128_000, kind: 'chat' });
  const overhead = toolSchemaReserveForKind('chat');

  it('limit is the real model window from the chat budget; used = recalled history + overhead', () => {
    const m = buildThreadContextMeter({ budget, messages: [msg(400), msg(800, 'assistant')], lastMessages: 20, overheadTokens: overhead });
    assert.equal(m.limitTokens, 128_000);
    assert.equal(m.limitSource, 'model');
    assert.equal(m.trimAtTokens, budget.limiterLimit);
    assert.equal(m.messageTokens, 100 + O + 200 + O);
    assert.equal(m.usedTokens, m.messageTokens + overhead);
    assert.equal(m.level, 'ok');
    assert.equal(m.totalMessages, 2);
  });

  it('counts only the memory recall window (last N messages)', () => {
    const messages = [msg(40_000), ...Array.from({ length: CHAT_MEMORY_LAST_MESSAGES }, () => msg(4))];
    const m = buildThreadContextMeter({ budget, messages, lastMessages: CHAT_MEMORY_LAST_MESSAGES, overheadTokens: 0 });
    assert.equal(m.windowMessages, CHAT_MEMORY_LAST_MESSAGES);
    assert.equal(m.totalMessages, CHAT_MEMORY_LAST_MESSAGES + 1);
    assert.equal(m.messageTokens, CHAT_MEMORY_LAST_MESSAGES * (1 + O));
  });

  it('caps history at the trim point and reports over', () => {
    const m = buildThreadContextMeter({ budget, messages: [msg(4 * 200_000)], lastMessages: 20, overheadTokens: overhead });
    assert.equal(m.usedTokens, budget.limiterLimit + overhead);
    assert.equal(m.level, 'over');
  });

  it('turns near at 80% of the OM observation threshold when OM is on', () => {
    const m = buildThreadContextMeter({ budget, messages: [msg(4 * 25_000)], lastMessages: 20, overheadTokens: 0, observeAfterTokens: 30_000 });
    assert.equal(m.level, 'near');
    const off = buildThreadContextMeter({ budget, messages: [msg(4 * 25_000)], lastMessages: 20, overheadTokens: 0 });
    assert.equal(off.level, 'ok');
  });

  it('falls back to the env limiter when no window is configured', () => {
    const env = resolveContextBudget({ kind: 'chat', envLimit: 120_000 });
    const m = buildThreadContextMeter({ budget: env, messages: [], lastMessages: 20, overheadTokens: overhead });
    assert.equal(m.limitTokens, 120_000);
    assert.equal(m.limitSource, 'env');
    assert.equal(m.usedTokens, overhead);
  });
});

describe('formatting', () => {
  it('formats token counts compactly', () => {
    assert.equal(formatTokenCount(980), '980');
    assert.equal(formatTokenCount(1_000), '1k');
    assert.equal(formatTokenCount(12_400), '12.4k');
    assert.equal(formatTokenCount(128_000), '128k');
    assert.equal(formatTokenCount(131_072), '131k');
    assert.equal(formatTokenCount(1_048_576), '1M');
    assert.equal(formatTokenCount(-5), '0');
  });
  it('label, ratio and tooltip', () => {
    const budget = resolveContextBudget({ maxContextTokens: 128_000, kind: 'chat' });
    const m = buildThreadContextMeter({ budget, messages: [msg(4 * 4_400)], lastMessages: 20, overheadTokens: 8_000, observeAfterTokens: 30_000 });
    assert.equal(contextMeterLabel(m), '~12.4k / 128k');
    assert.ok(Math.abs(contextMeterRatio(m) - m.usedTokens / 128_000) < 1e-9);
    const title = contextMeterTitle(m);
    assert.match(title, /model's context window \(128k\)/);
    assert.match(title, /trimmed above/);
    assert.match(title, /Observational Memory compacts history after ~30k/);
    assert.match(title, /estimate/i);
    assert.equal(contextMeterRatio({ usedTokens: 10, limitTokens: 0 }), 0);
  });
});
