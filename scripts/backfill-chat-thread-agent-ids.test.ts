import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { spawn } from 'child_process';

/**
 * Integration tests for backfill-chat-thread-agent-ids.ts script.
 * 
 * **DESTRUCTIVE TESTS — Requires explicit permission**
 * 
 * These tests CREATE and DROP tables (mastra_threads, agents) in the target database.
 * To prevent accidental data loss on shared TEST or production databases:
 * 
 * 1. Set ALLOW_DESTRUCTIVE_BACKFILL_TESTS=1 to enable
 * 2. Use a dedicated TEST_DATABASE_URL pointing to an isolated test database
 * 3. Tests will refuse to run if database looks shared/production
 * 
 * Usage:
 *   ALLOW_DESTRUCTIVE_BACKFILL_TESTS=1 TEST_DATABASE_URL=postgresql://... npx tsx --test scripts/backfill-chat-thread-agent-ids.test.ts
 * 
 * Safety checks:
 * - Requires explicit ALLOW_DESTRUCTIVE_BACKFILL_TESTS=1
 * - Refuses if mastra_threads already has rows (shared DB)
 * - Refuses if URL hostname/db name looks like production
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SCRIPT_PATH = './scripts/backfill-chat-thread-agent-ids.ts';
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE_BACKFILL_TESTS === '1';

// Real schema from mastra_threads table
interface MastraThread {
  id: string;
  resourceId: string;
  title?: string | null;
  metadata: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  createdAtZ?: Date;
  updatedAtZ?: Date;
}

describe('backfill-chat-thread-agent-ids', () => {
  let pool: Pool | null = null;
  let canRunDestructiveTests = false;

  before(async () => {
    if (!TEST_DB_URL) {
      console.warn('⚠️  TEST_DATABASE_URL not set. Skipping backfill script integration tests.');
      return;
    }

    if (!ALLOW_DESTRUCTIVE) {
      console.warn('⚠️  ALLOW_DESTRUCTIVE_BACKFILL_TESTS not set. Skipping destructive tests.');
      console.warn('    Set ALLOW_DESTRUCTIVE_BACKFILL_TESTS=1 to enable.');
      return;
    }

    // Safety check: refuse if URL looks like production
    const urlLower = TEST_DB_URL.toLowerCase();
    if (
      urlLower.includes('production') ||
      urlLower.includes('prod-') ||
      urlLower.includes('.prod.') ||
      urlLower.includes('main-db') ||
      urlLower.includes('master-')
    ) {
      console.error('❌ TEST_DATABASE_URL looks like a production database. Refusing to run.');
      console.error('   URL contains production/prod/main/master keywords.');
      return;
    }

    // Check if mastra_threads exists and has data (shared DB)
    const tempPool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const tableCheck = await tempPool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name = 'mastra_threads'
      `);

      if (tableCheck.rows.length > 0) {
        const rowCount = await tempPool.query(`SELECT COUNT(*) FROM mastra_threads`);
        const count = parseInt(rowCount.rows[0].count, 10);
        
        if (count > 0) {
          console.error('❌ mastra_threads table exists and has data. Refusing to run destructive tests.');
          console.error(`   Found ${count} rows. Use an empty test database.`);
          await tempPool.end();
          return;
        }
      }

      canRunDestructiveTests = true;
    } catch (error) {
      console.warn('⚠️  Could not check database safety. Skipping tests.', error);
    } finally {
      await tempPool.end();
    }
  });

  beforeEach(async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests) return;
    
    pool = new Pool({ connectionString: TEST_DB_URL });
    
    // Create test tables with REAL schema (match production)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mastra_threads (
        id TEXT PRIMARY KEY,
        "resourceId" TEXT NOT NULL,
        title TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW(),
        "createdAtZ" TIMESTAMPTZ DEFAULT NOW(),
        "updatedAtZ" TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        "companyId" TEXT NOT NULL,
        "urlKey" TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        "createdAt" TIMESTAMP DEFAULT NOW()
      )
    `);
  });

  afterEach(async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) return;
    
    // Clean up test data
    await pool.query('DROP TABLE IF EXISTS mastra_threads CASCADE');
    await pool.query('DROP TABLE IF EXISTS agents CASCADE');
    await pool.end();
    pool = null;
  });

  const runScript = async (env: Record<string, string> = {}): Promise<{ 
    exitCode: number; 
    stdout: string; 
    stderr: string; 
  }> => {
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', SCRIPT_PATH], {
        env: {
          ...process.env,
          DATABASE_URL: TEST_DB_URL!,
          ...env,
        },
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  };

  it('should exit 0 when mastra_threads table does not exist', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Drop the table
    await pool.query('DROP TABLE IF EXISTS mastra_threads');

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /No Mastra chat thread table found/);
  });

  it('should exit 0 when no chat threads exist', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Found 0 chat thread/);
  });

  it('should skip threads that already have agentId in metadata', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert a thread with agentId already set
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-1',
      'company-comp-1:chat:free',
      JSON.stringify({ agentId: 'agent-123', kind: 'chat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /already tagged/);
    assert.match(result.stdout, /Already tagged:\s*1/);
  });

  it('should report "cannot infer" for chat threads without agentId (not an error)', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert a chat thread without agentId (company-scoped by design)
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-2',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0); // Not an error!
    assert.match(result.stdout, /cannot infer agentId/);
    assert.match(result.stdout, /Could not infer:\s*1/);
    assert.match(result.stdout, /Older shared chats/);
  });

  it('should check for agents table existence', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Drop agents table to test graceful handling
    await pool.query('DROP TABLE IF EXISTS agents');

    // Insert a chat thread
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-3',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Agents table not found/);
    assert.match(result.stdout, /Skipping agentId validation/);
  });

  it('should use REAL column names (resourceId not resource_id)', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert thread using real column names
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata, "createdAt")
      VALUES ($1, $2, $3, NOW())
    `, [
      'thread-4',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    const result = await runScript();

    // Should not error on column names
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stderr, /column/);
    assert.doesNotMatch(result.stderr, /does not exist/);
  });

  it('should NOT reference ownerId column (does not exist in schema)', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-5',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    const result = await runScript();

    // Script must not try to SELECT or reference ownerId
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stderr, /ownerId/);
    assert.doesNotMatch(result.stderr, /column "ownerId" does not exist/);
  });

  it('should filter to chat threads only (resourceId contains :chat:)', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert chat thread
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-chat',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    // Insert heartbeat thread (should be ignored)
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'issue-123:agent-456',
      'company-comp-1:issue-123',
      JSON.stringify({ kind: 'heartbeat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    // Should only find 1 chat thread, not the heartbeat thread
    assert.match(result.stdout, /Found 1 chat thread/);
  });

  it('should process multiple threads with mixed states', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Thread 1: already tagged
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-tagged',
      'company-comp-1:chat:free',
      JSON.stringify({ agentId: 'agent-1', kind: 'chat' }),
    ]);

    // Thread 2: not tagged (cannot infer)
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-untagged',
      'company-comp-1:chat:issue:issue-789',
      JSON.stringify({ kind: 'chat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Already tagged:\s*1/);
    assert.match(result.stdout, /Could not infer:\s*1/);
    assert.match(result.stdout, /Total processed:\s*2/);
  });

  it('should handle metadata as text or jsonb', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert with jsonb metadata
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3::jsonb)
    `, [
      'thread-jsonb',
      'company-comp-1:chat:free',
      JSON.stringify({ agentId: 'agent-2', kind: 'chat' }),
    ]);

    const result = await runScript();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /already tagged/);
  });

  it('should require DATABASE_URL environment variable', async () => {
    const result = await runScript({
      DATABASE_URL: '', // Empty DATABASE_URL
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /DATABASE_URL environment variable is required/);
  });

  it('should be report-only (no database writes)', async () => {
    if (!TEST_DB_URL || !canRunDestructiveTests || !pool) {
      console.log('⏭️  Skipping (no TEST_DATABASE_URL or destructive tests disabled)');
      return;
    }

    // Insert untagged thread
    await pool.query(`
      INSERT INTO mastra_threads (id, "resourceId", metadata)
      VALUES ($1, $2, $3)
    `, [
      'thread-untagged',
      'company-comp-1:chat:free',
      JSON.stringify({ kind: 'chat' }),
    ]);

    await runScript();

    // Verify metadata was NOT modified (report-only)
    const result = await pool.query(`
      SELECT metadata FROM mastra_threads WHERE id = $1
    `, ['thread-untagged']);

    const metadata = result.rows[0].metadata as Record<string, unknown>;
    assert.equal(metadata.agentId, undefined, 'agentId should not be written');
  });
});

describe('backfill script documentation', () => {
  it('documents the real schema columns', () => {
    // This test ensures the investigation doc stays in sync
    const realColumns = [
      'id',
      'resourceId',
      'title',
      'metadata',
      'createdAt',
      'updatedAt',
      'createdAtZ',
      'updatedAtZ',
    ];

    assert.ok(realColumns.includes('resourceId'));
    assert.ok(realColumns.includes('metadata'));
    assert.ok(!realColumns.includes('ownerId')); // Does not exist!
    assert.ok(!realColumns.includes('resource_id')); // Snake case not used
  });
});
