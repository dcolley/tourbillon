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

  it('extracts JSON schemas from tool objects not createTool wrappers', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      kind: 'durable',
    });

    // Simulate Mastra tool objects with schema property
    const mockTools = [
      {
        name: 'getTodo',
        description: 'Get a todo item',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        execute: () => {},
      },
      {
        name: 'createTodo',
        description: 'Create a todo item',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['title'],
        },
        execute: () => {},
      },
    ];

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'durable',
      toolSchemas: mockTools,
    });

    // Should extract schemas, not stringify the whole tool objects
    assert.ok(snapshot.estimatedToolSchemaTokens > 0);
    
    // The estimate should be based on schema JSON, not including execute function
    // If it serialized the whole tool, execute would make it much larger
    assert.ok(snapshot.estimatedToolSchemaTokens < 500, 'Schema-only estimate should be smaller');
  });

  it('handles tools without schema properties', () => {
    const budget = resolveContextBudget({
      maxContextTokens: 32000,
      kind: 'durable',
    });

    // Tools without schema properties should still produce estimates
    const toolsWithoutSchema = [
      { name: 'tool1', description: 'A tool' },
      { name: 'tool2', description: 'Another tool' },
    ];

    const snapshot = createContextBudgetSnapshot({
      budget,
      kind: 'durable',
      toolSchemas: toolsWithoutSchema,
    });

    // Should still estimate based on name/description
    assert.ok(snapshot.estimatedToolSchemaTokens > 0);
  });
});
