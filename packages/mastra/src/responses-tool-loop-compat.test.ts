import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coalesceConsecutiveUserMessages,
  stripAssistantReasoning,
  stripAssistantReasoningFromPrompt,
  stripToolLoopAssistantMonologue,
  stripToolLoopMonologueFromPrompt,
  type ToolLoopCompatPrompt,
} from './responses-tool-loop-compat';

const toolCall = {
  type: 'tool-call',
  toolCallId: 'call_1',
  toolName: 'mastra_workspace_execute_command',
  input: { command: 'echo hi' },
};

describe('coalesceConsecutiveUserMessages', () => {
  it('merges adjacent user messages', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
    ];
    const next = coalesceConsecutiveUserMessages(prompt);
    assert.ok(next);
    assert.equal(next.length, 2);
    assert.deepEqual(next[0]?.content, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });
});

describe('stripAssistantReasoningFromPrompt', () => {
  it('strips reasoning and keeps text on assistant messages', () => {
    const prompt: ToolLoopCompatPrompt = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Think.' },
          { type: 'text', text: 'Hello!' },
        ],
      },
    ];
    const next = stripAssistantReasoningFromPrompt(prompt);
    assert.ok(next);
    assert.deepEqual(next[0]?.content, [{ type: 'text', text: 'Hello!' }]);
  });

  it('drops reasoning-only assistant messages', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '…' }] },
      { role: 'user', content: [{ type: 'text', text: 'Again' }] },
    ];
    const next = stripAssistantReasoningFromPrompt(prompt);
    assert.ok(next);
    assert.equal(next.length, 2);
    assert.equal(next[0]?.role, 'user');
    assert.equal(next[1]?.role, 'user');
  });

  it('leaves prompts without reasoning unchanged', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    assert.equal(stripAssistantReasoningFromPrompt(prompt), undefined);
  });
});

describe('stripAssistantReasoning', () => {
  it('exposes the expected CompatRule name', () => {
    assert.equal(stripAssistantReasoning.name, 'strip-assistant-reasoning');
    assert.ok(stripAssistantReasoning.applyToPrompt);
  });
});

describe('stripToolLoopMonologueFromPrompt', () => {
  it('leaves assistant text-only messages unchanged', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    assert.equal(stripToolLoopMonologueFromPrompt(prompt), undefined);
  });

  it('leaves assistant reasoning-only messages unchanged', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Thinking…' }] },
    ];
    assert.equal(stripToolLoopMonologueFromPrompt(prompt), undefined);
  });

  it('strips text when the same assistant message has a tool-call', () => {
    const prompt: ToolLoopCompatPrompt = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will run echo.' }, toolCall],
      },
    ];
    const next = stripToolLoopMonologueFromPrompt(prompt);
    assert.ok(next);
    assert.deepEqual(next[0]?.content, [toolCall]);
  });

  it('strips reasoning when the same assistant message has a tool-call', () => {
    const prompt: ToolLoopCompatPrompt = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Plan the command.' }, toolCall],
      },
    ];
    const next = stripToolLoopMonologueFromPrompt(prompt);
    assert.ok(next);
    assert.deepEqual(next[0]?.content, [toolCall]);
  });

  it('strips both text and reasoning when a tool-call is present', () => {
    const prompt: ToolLoopCompatPrompt = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Think.' },
          { type: 'text', text: 'Say.' },
          toolCall,
        ],
      },
    ];
    const next = stripToolLoopMonologueFromPrompt(prompt);
    assert.ok(next);
    assert.deepEqual(next[0]?.content, [toolCall]);
  });

  it('leaves user messages unchanged', () => {
    const prompt: ToolLoopCompatPrompt = [
      { role: 'user', content: [{ type: 'text', text: 'Wake reason: on_demand' }] },
    ];
    assert.equal(stripToolLoopMonologueFromPrompt(prompt), undefined);
  });
});

describe('stripToolLoopAssistantMonologue', () => {
  it('exposes the expected CompatRule name and applyToPrompt', () => {
    assert.equal(stripToolLoopAssistantMonologue.name, 'strip-tool-loop-assistant-monologue');
    assert.ok(stripToolLoopAssistantMonologue.applyToPrompt);

    const prompt = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Monologue' },
          {
            type: 'tool-call' as const,
            toolCallId: 'c1',
            toolName: 'getInbox',
            input: {},
          },
        ],
      },
    ];
    const result = stripToolLoopAssistantMonologue.applyToPrompt!({
      prompt: prompt as never,
      model: 'test',
    });
    assert.ok(result);
    assert.deepEqual((result as typeof prompt)[0]?.content, [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'getInbox',
        input: {},
      },
    ]);
  });
});
