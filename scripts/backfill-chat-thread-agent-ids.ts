#!/usr/bin/env tsx
/**
 * Backfill agentId metadata for existing chat threads.
 * 
 * Idempotent: Threads already tagged with agentId are skipped.
 * 
 * Usage (from repo root):
 *   npx tsx scripts/backfill-chat-thread-agent-ids.ts
 * 
 * Environment variables:
 *   DATABASE_URL - Required (same as app)
 *   DRY_RUN - Set to "true" to preview changes without writing (optional)
 * 
 * Inference strategy:
 *   1. Check thread metadata for existing agentId tag → skip if present
 *   2. Extract agent ID from thread.resourceId if it contains agent info
 *   3. Look at controller storage metadata if available
 *   4. If no clear agent, thread remains untagged (will appear in "Older shared chats")
 * 
 * Note: The current Mastra thread storage does not reliably record which agent
 * created the thread. The resourceId is company-scoped (e.g. "company-{id}:chat:free"),
 * not agent-scoped. Assistant messages do not include agent metadata in the standard
 * Mastra schema.
 * 
 * Result: Most existing threads will remain untagged and appear in "Older shared chats"
 * for all agents. They will be tagged to the current agent when a user sends their
 * first message in that shared thread.
 */

import { Pool } from 'pg';

interface ThreadRow {
  id: string;
  resourceId: string;
  metadata: string | Record<string, unknown>;
}

async function backfillChatThreadAgentIds() {
  const databaseUrl = process.env.DATABASE_URL;
  const dryRun = process.env.DRY_RUN === 'true';

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('🔍 Starting chat thread agentId backfill...');
  if (dryRun) {
    console.log('🏃 DRY RUN mode: no changes will be written\n');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Mastra managed table (not custom storage ID format)
    const threadsTable = 'mastra_threads';

    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name = 'mastra_threads'
    `);

    if (tableCheck.rows.length === 0) {
      console.log('⚠️  No Mastra chat thread table found. This is expected if no chat sessions exist yet.');
      console.log('   Table will be created automatically when the first chat session is created.');
      return;
    }

    console.log(`✓ Found Mastra storage table: mastra_threads\n`);

    // Find all chat threads (resourceId contains ':chat:')
    const threadsResult = await pool.query<ThreadRow>(`
      SELECT id, "resourceId", metadata
      FROM ${threadsTable}
      WHERE "resourceId" LIKE '%:chat:%'
      ORDER BY "createdAt" DESC
    `);

    const threads = threadsResult.rows;
    console.log(`Found ${threads.length} chat thread(s)\n`);

    if (threads.length === 0) {
      console.log('No chat threads to process.');
      return;
    }

    let alreadyTagged = 0;
    let couldNotInfer = 0;

    for (const thread of threads) {
      // Parse metadata if it's stored as text (PostgreSQL may return JSON columns as text)
      let metadata: Record<string, unknown>;
      if (typeof thread.metadata === 'string') {
        try {
          metadata = JSON.parse(thread.metadata) as Record<string, unknown>;
        } catch {
          metadata = {};
        }
      } else {
        metadata = thread.metadata || {};
      }
      
      // Skip if already tagged
      if (metadata.agentId) {
        alreadyTagged++;
        console.log(`  ⏭️  Thread ${thread.id.slice(0, 8)}... already tagged (agentId: ${metadata.agentId})`);
        continue;
      }

      // Cannot reliably infer agentId from current Mastra storage schema:
      // - resourceId is company-scoped: "company-{companyId}:chat:free"
      // - Assistant messages do not include agent metadata
      // - No FK relationship between threads and agents table
      couldNotInfer++;
      console.log(`  ⚠️  Thread ${thread.id.slice(0, 8)}... cannot infer agentId (will appear in "Older shared chats")`);
    }

    console.log('\n📊 Summary:');
    console.log(`  Already tagged: ${alreadyTagged}`);
    console.log(`  Could not infer: ${couldNotInfer}`);
    console.log(`\n  ℹ️  Inference limitation: Mastra thread storage does not record which agent created the thread.`);
    console.log(`     resourceId is company-scoped (e.g. "company-{id}:chat:free"), not agent-scoped.`);
    console.log(`     Assistant messages do not include agent metadata in the standard schema.`);
    console.log(`\n  Untagged threads will appear in "Older shared chats" for all agents.`);
    console.log(`  They will be tagged to the current agent when a user sends their first message.`);
    console.log('\n✅ Backfill complete (no inference possible with current schema).');

  } catch (error) {
    console.error('❌ Error during backfill:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backfillChatThreadAgentIds();
