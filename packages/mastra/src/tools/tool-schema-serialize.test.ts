import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { serializeToolInputSchema } from './tool-schema-serialize';

const sampleTool = createTool({
  id: 'putPlanDocument',
  description: 'sample',
  inputSchema: z.object({
    issueId: z.string(),
    body: z.string(),
    baseRevisionId: z.string().nullable().default(null),
  }),
  execute: async () => ({}),
});

describe('serializeToolInputSchema', () => {
  it('raw createTool Zod inputSchema is not structuredClone-safe (TEST repro)', () => {
    assert.throws(
      () => structuredClone({ inputSchema: sampleTool.inputSchema }),
      /could not be cloned/,
    );
  });

  it('getToolDetails-shaped result survives structuredClone (SessionRunEngine.emitMessagePart)', () => {
    const result = {
      id: 'putPlanDocument',
      description: 'sample',
      inputSchema: serializeToolInputSchema(sampleTool.inputSchema),
    };
    // Mirrors @mastra/core 1.75 session-run-engine.ts:342 `structuredClone(part)`.
    const part = { type: 'tool-invocation', toolInvocation: { state: 'result', result } };
    assert.doesNotThrow(() => structuredClone(part));
  });

  it('returns JSON Schema the model can read', () => {
    const js = serializeToolInputSchema(sampleTool.inputSchema)!;
    assert.equal(js.type, 'object');
    assert.deepEqual(Object.keys(js.properties as object).sort(), ['baseRevisionId', 'body', 'issueId']);
    assert.ok((js.required as string[]).includes('issueId'));
  });

  it('strips functions from AI SDK jsonSchema() wrappers / plain objects', () => {
    const wrapped = { jsonSchema: { type: 'object', properties: { q: { type: 'string' } } }, validate: () => true };
    const js = serializeToolInputSchema(wrapped)!;
    assert.deepEqual(js, { type: 'object', properties: { q: { type: 'string' } } });
    assert.doesNotThrow(() => structuredClone(js));
  });

  it('returns null for missing schema', () => {
    assert.equal(serializeToolInputSchema(undefined), null);
  });
});
