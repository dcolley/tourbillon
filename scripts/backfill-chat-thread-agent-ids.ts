#!/usr/bin/env tsx
/**
 * Backfill agentId metadata for existing chat threads.
 * 
 * **Report-only** — this script does NOT write to the database. It classifies
 * chat threads as either already-tagged or cannot-infer for reporting purposes.
 * 
 * Idempotent: Threads already tagged with agentId are skipped.
 * 
 * Usage (from repo root):
 *   npx tsx scripts/backfill-chat-thread-agent-ids.ts
 * 
 * Environment variables:
 *   DATABASE_URL - Required (same as app)
 *   DRY_RUN - Ignored (script never writes)
 * 
 * Behavior:
 *   1. Check thread metadata for existing agentId tag → report as "already tagged"
 *   2. Chat threads without agentId → report as "cannot infer"
 * 
 * Inference limitation:
 *   Chat threads are company-scoped (resourceId: "company-{id}:chat:free"), not
 *   agent-scoped. The ownerId column does not exist in mastra_threads on TEST.
 *   Untagged threads remain in "Older shared chats" until a user sends a message.
 * 
 * Note: Threads created after commit a9a59c7 (2026-10-05) have agentId in metadata.
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
  } else {
    console.log('📋 REPORT mode: this script does not write to the database\n');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Mastra managed table (not custom storage ID format)
    const threadsTable = 'mastra_threads';

    // Check if mastra_threads table exists
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

    // Check if agents table exists (for future validation if inference is added)
    const agentsTableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name = 'agents'
    `);

    const agentsTableExists = agentsTableCheck.rows.length > 0;
    if (!agentsTableExists) {
      console.log('⚠️  Agents table not found. Skipping agentId validation.');
      console.log('   This is expected if the database schema is not fully initialized.\n');
    } else {
      console.log('✓ Found agents table for validation\n');
    }

    // Find all chat threads (resourceId contains ':chat:')
    // Note: ownerId column does not exist in mastra_threads schema on TEST
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
      // - ownerId column does not exist in mastra_threads on TEST
      // - No FK relationship between threads and agents table
      couldNotInfer++;
      console.log(`  ⚠️  Thread ${thread.id.slice(0, 8)}... cannot infer agentId (will appear in "Older shared chats")`);
    }

    console.log('\n📊 Summary:');
    console.log(`  Already tagged: ${alreadyTagged}`);
    console.log(`  Could not infer: ${couldNotInfer}`);
    console.log(`  Total processed: ${alreadyTagged + couldNotInfer}`);
    console.log(`\n  ℹ️  Inference limitation: Mastra thread storage does not record which agent created the thread.`);
    console.log(`     resourceId is company-scoped (e.g. "company-{id}:chat:free"), not agent-scoped.`);
    console.log(`     The ownerId column does not exist in mastra_threads schema.`);
    console.log(`\n  Untagged threads will appear in "Older shared chats" for all agents.`);
    console.log(`  They will be tagged to the current agent when a user sends their first message.`);
    console.log('\n✅ Backfill report complete.');

  } catch (error) {
    console.error('❌ Error during backfill:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backfillChatThreadAgentIds();
