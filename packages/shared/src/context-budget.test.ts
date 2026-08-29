import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContextBudgetSnapshot, resolveContextBudget } from './context-budget';

describe('createContextBudgetSnapshot', () => {
  it('creates snapshot with estimated tool schema tokens', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      maxOutputTokens: 2048,
      kind: 'durable',
    });

    const tools = [
      { name: 'getTodo', description: 'Get a todo item', parameters: { type: 'object' } },
      { name: 'createTodo', description: 'Create a todo item', parameters: { type: 'object' } },
    ];

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'durable',
      toolSchemas: tools,
      systemPrompt: 'You are a helpful assistant.',
    });

    assert.equal(snapshot.kind, 'durable');
    assert.equal(snapshot.maxContextTokens, 32000);
    assert.equal(snapshot.toolReserve, 8000);
    assert.ok(snapshot.estimatedToolSchemaTokens > 0);
    assert.ok(snapshot.estimatedSystemTokens > 0);
  });

  it('handles missing tool schemas and system prompt', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      kind: 'harness',
    });

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'harness',
    });

    assert.equal(snapshot.kind, 'harness');
    assert.equal(snapshot.toolReserve, 16000);
    assert.equal(snapshot.estimatedToolSchemaTokens, 0);
    assert.equal(snapshot.estimatedSystemTokens, 0);
  });

  it('estimates tokens as roughly 1/4 of character count', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      kind: 'durable',
    });

    // A 1000-char string should estimate to ~250 tokens
    const longPrompt = 'x'.repeat(1000);

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'durable',
      systemPrompt: longPrompt,
    });

    assert.ok(snapshot.estimatedSystemTokens >= 240);
    assert.ok(snapshot.estimatedSystemTokens <= 260);
  });

  it('handles serialization errors gracefully', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      kind: 'durable',
    });

    const circular: any = {};
    circular.self = circular;

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'durable',
      toolSchemas: [circular],
    });

    assert.equal(snapshot.estimatedToolSchemaTokens, 0);
  });
});
