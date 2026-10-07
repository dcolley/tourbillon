import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ZERO_PLAIN_USER_TRIPWIRE,
  capToolResultText,
  countPlainUserMessages,
  ensurePinnedPlainUser,
  findFirstPlainUserMessage,
  isPlainUserMessage,
  PinPlainUserAfterTrimProcessor,
  type GuardPrompt,
} from './qwen-plain-user-guard';

const wake: GuardPrompt[number] = {
  role: 'user',
  content: [{ type: 'text', text: 'Wake reason: timer\n\nBegin your heartbeat procedure.' }],
};

const systemMsg: GuardPrompt[number] = {
  role: 'system',
  content: 'You are CTO.',
};

const assistantToolCall: GuardPrompt[number] = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'mastra_workspace_execute_command',
      input: { command: 'ls' },
    },
  ],
};

const toolResult: GuardPrompt[number] = {
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'mastra_workspace_execute_command',
      output: { type: 'text', value: 'ok' },
    },
  ],
};

describe('isPlainUserMessage / countPlainUserMessages', () => {
  it('counts text user turns as plain users', () => {
    const prompt: GuardPrompt = [systemMsg, wake, assistantToolCall, toolResult];
    assert.equal(countPlainUserMessages(prompt), 1);
    assert.equal(isPlainUserMessage(wake), true);
    assert.equal(isPlainUserMessage(toolResult), false);
    assert.equal(isPlainUserMessage(assistantToolCall), false);
  });

  it('returns 0 for the failing Demo shape (system+assistant+tool only)', () => {
    const failStep: GuardPrompt = [systemMsg, assistantToolCall, toolResult];
    assert.equal(countPlainUserMessages(failStep), 0);
    assert.equal(findFirstPlainUserMessage(failStep), undefined);
  });
});

describe('ensurePinnedPlainUser', () => {
  it('re-inserts the wake after system when plain_user=0', () => {
    const failStep: GuardPrompt = [systemMsg, assistantToolCall, toolResult];
    const next = ensurePinnedPlainUser(failStep, wake);
    assert.equal(countPlainUserMessages(next), 1);
    assert.equal(next[0]?.role, 'system');
    assert.equal(next[1]?.role, 'user');
    assert.deepEqual(next[1]?.content, wake.content);
    assert.equal(next[2]?.role, 'assistant');
  });

  it('leaves prompts that already have a plain user unchanged (same reference)', () => {
    const ok: GuardPrompt = [systemMsg, wake, assistantToolCall, toolResult];
    const next = ensurePinnedPlainUser(ok, wake);
    assert.equal(next, ok);
  });
});

describe('capToolResultText', () => {
  it('truncates oversized tool-result text output', () => {
    const big = 'x'.repeat(500);
    const prompt: GuardPrompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 't',
            output: { type: 'text', value: big },
          },
        ],
      },
    ];
    const next = capToolResultText(prompt, 100);
    assert.ok(next);
    const out = (next[0]?.content as any)[0].output.value as string;
    assert.ok(out.length < big.length);
    assert.ok(out.includes('[truncated'));
  });

  it('returns undefined when nothing exceeds the cap', () => {
    const prompt: GuardPrompt = [toolResult];
    assert.equal(capToolResultText(prompt, 12_000), undefined);
  });
});

describe('PinPlainUserAfterTrimProcessor', () => {
  it('pins wake on an early step and restores it after contiguous trim', () => {
    const proc = new PinPlainUserAfterTrimProcessor({ toolResultMaxChars: 0 });
    const state: Record<string, unknown> = {};
    const abort = () => {
      throw new Error('abort should not fire');
    };

    // Step 0–5 shape: system + plain user + tool loop
    const early = {
      prompt: [systemMsg, wake, assistantToolCall, toolResult] as any,
      abort: abort as any,
      state,
      stepNumber: 5,
      steps: [],
      model: {} as any,
      retryCount: 0,
    };
    const earlyResult = proc.processLLMRequest(early);
    assert.equal(earlyResult, undefined); // already has plain user
    assert.ok(state.pinnedPlainUser);

    // Step 6 FAIL shape from Demo: system + assistant + tool only
    const fail = {
      prompt: [systemMsg, assistantToolCall, toolResult] as any,
      abort: abort as any,
      state,
      stepNumber: 6,
      steps: [],
      model: {} as any,
      retryCount: 0,
    };
    const restored = proc.processLLMRequest(fail);
    assert.ok(restored && 'prompt' in restored && restored.prompt);
    assert.equal(countPlainUserMessages(restored.prompt as GuardPrompt), 1);
    assert.equal((restored.prompt as GuardPrompt)[1]?.role, 'user');
  });

  it('TripWires (fail closed) when plain_user=0 and no pin/recovery', () => {
    const proc = new PinPlainUserAfterTrimProcessor({ toolResultMaxChars: 0 });
    const state: Record<string, unknown> = {};
    let aborted: { reason?: string; metadata?: unknown } | null = null;
    const abort = (reason?: string, options?: { metadata?: unknown }) => {
      aborted = { reason, metadata: options?.metadata };
      throw new Error(reason ?? 'aborted');
    };

    assert.throws(
      () =>
        proc.processLLMRequest({
          prompt: [systemMsg, assistantToolCall, toolResult] as any,
          abort: abort as any,
          state,
          stepNumber: 6,
          steps: [],
          model: {} as any,
          retryCount: 0,
        }),
      /No plain role:user/,
    );
    assert.ok(aborted);
    assert.equal(aborted!.reason, ZERO_PLAIN_USER_TRIPWIRE);
    assert.deepEqual((aborted!.metadata as any).code, 'ZERO_PLAIN_USER_AFTER_TRIM');
  });

  it('processInput captures first DB user wake into pin state', () => {
    const proc = new PinPlainUserAfterTrimProcessor({ toolResultMaxChars: 0 });
    const state: Record<string, unknown> = {};
    const messages = [
      {
        id: '1',
        role: 'user',
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: 'text', text: 'Wake reason: on_demand' }] },
      },
    ] as any;

    proc.processInput({
      messages,
      messageList: {} as any,
      systemMessages: [],
      state,
      abort: (() => {
        throw new Error('no');
      }) as any,
      retryCount: 0,
    });

    assert.ok(state.pinnedPlainUser);
    assert.equal(
      ((state.pinnedPlainUser as GuardPrompt[number]).content as any)[0].text,
      'Wake reason: on_demand',
    );
  });
});
