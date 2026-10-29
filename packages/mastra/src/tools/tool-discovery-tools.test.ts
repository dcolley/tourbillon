/**
 * Tool Discovery Tools — listTools / getToolDetails behaviour.
 *
 * S1 (#189 soft-pack D): this file imported from `vitest`, which the package never
 * declared, so `pnpm test` (`node --import tsx --test`) could not load it at all.
 * Converted to node:test + node:assert/strict (the package-wide runner convention)
 * and moved off the live `db` pool onto the `toolDb()` test seam with an in-memory
 * PGlite — same pattern as the S7 section of chat-task-tools.test.ts.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as dbSchema from '@tourbillon/db/schema';
import { listToolsTool, getToolDetailsTool } from './tool-discovery-tools';
import { setToolDbForTests, type ToolDb } from './tool-db';

const MIGRATIONS_DIR = path.join(__dirname, '../../../db/src/migrations');

const TEST_COMPANY_ID = 'td-company-1';
const TEST_AGENT_ID = 'td-agent-1';

// S189-S1b: the tool-discovery-tools ↔ agent-factory ↔ control-plane-tools import cycle is
// broken product-side (tool-discovery-tools lazy-loads agent-factory at execute time), so
// the former "import './control-plane-tools' first" load-order pin is gone — importing
// this module directly is now safe from any entry point.

/**
 * S189-S1c: the migration suite runs ONCE per file (was once per test, ~13s of setup for
 * 9 tests). Per-test isolation is preserved by truncating the fixture tables before each
 * test and reseeding — CASCADE also clears the dependent agents rows.
 */
let client: PGlite;
let seededDb: ToolDb;

async function seedFixtureRows(): Promise<void> {
  await seededDb
    .insert(dbSchema.companies)
    .values({
      id: TEST_COMPANY_ID,
      name: 'Test Company',
      slug: 'test-company',
      issuePrefix: 'TC',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
  await seededDb
    .insert(dbSchema.agents)
    .values({
      id: TEST_AGENT_ID,
      companyId: TEST_COMPANY_ID,
      name: 'Test Agent',
      urlKey: 'test-agent',
      title: 'Test Agent',
      role: 'ceo',
      assignedSkills: ['control-plane'],
      assignedToolsets: ['web-search', 'comments'],
      runtimeConfig: { searxngUrl: 'http://localhost:8080' },
      adapterType: 'lmstudio',
      modelId: 'test-model',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
}

type ToolResult = Record<string, any>;

describe('Tool Discovery Tools', () => {
  let mockContext: unknown;

  before(async () => {
    client = new PGlite();
    for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) {
      for (const chunk of m.sql) {
        if (chunk.trim()) await client.exec(chunk);
      }
    }
    seededDb = drizzlePglite(client, { schema: dbSchema }) as unknown as ToolDb;
  });

  after(async () => {
    setToolDbForTests(null);
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec('TRUNCATE companies CASCADE');
    await seedFixtureRows();
    setToolDbForTests(seededDb);

    // extractToolRuntimeContext accepts the plain-object shape (api-client fallback branch).
    mockContext = {
      requestId: 'test-request',
      agentId: TEST_AGENT_ID,
      companyId: TEST_COMPANY_ID,
      runId: 'test-run',
    };
  });

  afterEach(async () => {
    setToolDbForTests(null);
  });

  describe('listTools', () => {
    it('should return a compact list of available tools', async () => {
      const result = (await listToolsTool.execute!(
        {},
        { requestContext: mockContext } as never,
      )) as ToolResult;

      assert.ok(result.tools, 'result must carry tools');
      // S189-S1e: explicit presence/type check instead of truthiness (count may be 0
      // legitimately for a tool-less agent; the > 0 assert below pins this fixture).
      assert.ok('count' in result, 'result must carry count');
      assert.equal(typeof result.count, 'number', 'count must be a number');
      assert.ok(Array.isArray(result.tools));
      assert.ok(result.count > 0);

      // Check structure of first tool
      const firstTool = result.tools[0];
      assert.ok(firstTool.id);
      assert.ok(firstTool.description);
      assert.equal(typeof firstTool.description, 'string');
      assert.ok(firstTool.description.length < 300);
    });

    it('should include control-plane tools', async () => {
      const result = (await listToolsTool.execute!(
        {},
        { requestContext: mockContext } as never,
      )) as ToolResult;

      const toolIds: string[] = result.tools.map((t: any) => t.id);
      for (const expected of [
        'getIdentity',
        'getInbox',
        'checkoutIssue',
        'listSkills',
        'getSkill',
        'listTools',
        'getToolDetails',
      ]) {
        assert.ok(toolIds.includes(expected), `expected tool id ${expected} in ${toolIds}`);
      }
    });

    it('should include assigned toolset tools', async () => {
      const result = (await listToolsTool.execute!(
        {},
        { requestContext: mockContext } as never,
      )) as ToolResult;

      const toolIds: string[] = result.tools.map((t: any) => t.id);
      // web-search toolset
      assert.ok(toolIds.includes('searxngSearch'), 'expected searxngSearch from web-search toolset');
      // comments toolset
      assert.ok(toolIds.includes('addComment'), 'expected addComment from comments toolset');
    });

    it('should mark toolset tools with toolset property', async () => {
      const result = (await listToolsTool.execute!(
        {},
        { requestContext: mockContext } as never,
      )) as ToolResult;

      const commentTool = result.tools.find((t: any) => t.id === 'addComment');
      assert.equal(commentTool.toolset, 'comments');
    });

    it('should return error when agent not found', async () => {
      const invalidContext = {
        ...(mockContext as Record<string, unknown>),
        agentId: 'invalid-agent-id',
      };

      const result = (await listToolsTool.execute!(
        {},
        { requestContext: invalidContext } as never,
      )) as ToolResult;

      assert.equal(result.error, 'agent_not_found');
    });
  });

  describe('getToolDetails', () => {
    it('should return full details for a valid tool', async () => {
      const result = (await getToolDetailsTool.execute!(
        { id: 'getIdentity' },
        { requestContext: mockContext } as never,
      )) as ToolResult;

      assert.equal(result.id, 'getIdentity');
      assert.ok(result.description);
      assert.ok(result.inputSchema);
      assert.equal(typeof result.description, 'string');
    });

    it('should return error and available ids for unknown tool', async () => {
      const result = (await getToolDetailsTool.execute!(
        { id: 'nonexistentTool' },
        { requestContext: mockContext } as never,
      )) as ToolResult;

      assert.equal(result.error, 'tool_not_found');
      assert.ok(result.availableIds);
      assert.ok(Array.isArray(result.availableIds));
      assert.ok(result.availableIds.length > 0);
    });

    it('should return schema for assigned toolset tools', async () => {
      const result = (await getToolDetailsTool.execute!(
        { id: 'searxngSearch' },
        { requestContext: mockContext } as never,
      )) as ToolResult;

      assert.equal(result.id, 'searxngSearch');
      assert.ok(result.inputSchema);
      assert.equal(result.toolset, 'web-search');
    });

    it('should return error when agent not found', async () => {
      const invalidContext = {
        ...(mockContext as Record<string, unknown>),
        agentId: 'invalid-agent-id',
      };

      const result = (await getToolDetailsTool.execute!(
        { id: 'getIdentity' },
        { requestContext: invalidContext } as never,
      )) as ToolResult;

      assert.equal(result.error, 'agent_not_found');
    });
  });
});
