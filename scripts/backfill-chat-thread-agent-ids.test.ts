import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { Pool } from 'pg';
import { execSync } from 'child_process';

describe('backfill-chat-thread-agent-ids', () => {
  let pool: Pool;
  const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  beforeEach(async () => {
    if (!testDbUrl) {
      throw new Error('TEST_DATABASE_URL or DATABASE_URL required for tests');
    }

    pool = new Pool({ connectionString: testDbUrl });

    // Create test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mastra_threads (
        id TEXT PRIMARY KEY,
        "resourceId" TEXT NOT NULL,
        "ownerId" TEXT,
        metadata JSONB DEFAULT '{}',
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      )
    `);

    // Clear any existing test data
    await pool.query(`DELETE FROM mastra_threads WHERE "resourceId" LIKE '%:chat:%'`);
  });

  afterEach(async () => {
    // Clean up
    await pool.query(`DELETE FROM mastra_threads WHERE "resourceId" LIKE '%:chat:%'`);
    await pool.end();
  });

  it('should skip threads that already have agentId in metadata', async () => {
    const agentId = 'agent-123';
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-1',
      'company-abc:chat:free',
      `tourbillon-chat-${agentId}`,
      JSON.stringify({ agentId, kind: 'chat' })
    ]);

    const result = execSync(
      `DRY_RUN=true tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Already tagged: 1/);
    assert.match(result, /Inferred from ownerId: 0/);
    assert.match(result, /Could not infer: 0/);
  });

  it('should infer agentId from ownerId format: tourbillon-chat-{agentId}', async () => {
    const agentId = 'agent-456';
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-2',
      'company-abc:chat:free',
      `tourbillon-chat-${agentId}`,
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Inferred from ownerId: 1/);

    // Verify the metadata was updated
    const updated = await pool.query(
      `SELECT metadata FROM mastra_threads WHERE id = $1`,
      ['thread-2']
    );
    const metadata = updated.rows[0].metadata as { agentId?: string };
    assert.equal(metadata.agentId, agentId);
  });

  it('should infer agentId from ownerId format with modelId: tourbillon-chat-{agentId}::{modelId}', async () => {
    const agentId = 'agent-789';
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-3',
      'company-abc:chat:free',
      `tourbillon-chat-${agentId}::llama-3.3-70b`,
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Inferred from ownerId: 1/);

    // Verify the metadata was updated
    const updated = await pool.query(
      `SELECT metadata FROM mastra_threads WHERE id = $1`,
      ['thread-3']
    );
    const metadata = updated.rows[0].metadata as { agentId?: string };
    assert.equal(metadata.agentId, agentId);
  });

  it('should not infer agentId for threads without ownerId', async () => {
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-4',
      'company-abc:chat:free',
      null,
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `DRY_RUN=true tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Could not infer: 1/);
    assert.match(result, /Inferred from ownerId: 0/);
  });

  it('should not infer agentId for threads with unexpected ownerId format', async () => {
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-5',
      'company-abc:chat:free',
      'some-other-format',
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `DRY_RUN=true tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Could not infer: 1/);
    assert.match(result, /Inferred from ownerId: 0/);
  });

  it('should handle metadata as text string', async () => {
    const agentId = 'agent-text';
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4::text)
    `, [
      'thread-6',
      'company-abc:chat:free',
      `tourbillon-chat-${agentId}`,
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Inferred from ownerId: 1/);

    // Verify the metadata was updated
    const updated = await pool.query(
      `SELECT metadata FROM mastra_threads WHERE id = $1`,
      ['thread-6']
    );
    const metadata = updated.rows[0].metadata as { agentId?: string };
    assert.equal(metadata.agentId, agentId);
  });

  it('should process multiple threads correctly', async () => {
    // Already tagged
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-tagged',
      'company-abc:chat:free',
      'tourbillon-chat-agent-a',
      JSON.stringify({ agentId: 'agent-a', kind: 'chat' })
    ]);

    // Can infer
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-infer',
      'company-abc:chat:free',
      'tourbillon-chat-agent-b',
      JSON.stringify({ kind: 'chat' })
    ]);

    // Cannot infer
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", "ownerId", metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      'thread-no-owner',
      'company-abc:chat:free',
      null,
      JSON.stringify({ kind: 'chat' })
    ]);

    const result = execSync(
      `tsx scripts/backfill-chat-thread-agent-ids.ts`,
      { env: { ...process.env, DATABASE_URL: testDbUrl }, encoding: 'utf-8' }
    );

    assert.match(result, /Found 3 chat thread\(s\)/);
    assert.match(result, /Already tagged: 1/);
    assert.match(result, /Inferred from ownerId: 1/);
    assert.match(result, /Could not infer: 1/);

    // Verify only the inferable thread was updated
    const inferred = await pool.query(
      `SELECT metadata FROM mastra_threads WHERE id = $1`,
      ['thread-infer']
    );
    const metadata = inferred.rows[0].metadata as { agentId?: string };
    assert.equal(metadata.agentId, 'agent-b');
  });
});
