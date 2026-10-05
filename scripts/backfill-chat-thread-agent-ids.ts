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
 *   2. Extract agent ID from thread.ownerId (format: "tourbillon-chat-{agentId}")
 *   3. If no ownerId or unexpected format, thread remains untagged (will appear in "Older shared chats")
 * 
 * Note: Threads created after commit a9a59c7 (2026-10-05) have agentId in metadata.
 * Older threads can be inferred from ownerId if available. Very old threads without
 * ownerId will remain untagged and appear in "Older shared chats" for all agents.
 * They will be tagged to the current agent when a user sends their first message.
 */

import { Pool } from 'pg';

interface ThreadRow {
  id: string;
  resourceId: string;
  metadata: string | Record<string, unknown>;
  ownerId?: string;
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
      SELECT id, "resourceId", metadata, "ownerId"
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
    let inferred = 0;

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

      // Try to infer agentId from ownerId field
      // Format: "tourbillon-chat-{agentId}" or "tourbillon-chat-{agentId}::{modelId}"
      let inferredAgentId: string | null = null;
      if (thread.ownerId) {
        const ownerMatch = thread.ownerId.match(/^tourbillon-chat-([^:]+)/);
        if (ownerMatch) {
          inferredAgentId = ownerMatch[1];
        }
      }

      if (!inferredAgentId) {
        couldNotInfer++;
        console.log(`  ⚠️  Thread ${thread.id.slice(0, 8)}... cannot infer agentId (will appear in "Older shared chats")`);
        continue;
      }

      // Update thread metadata with inferred agentId
      if (!dryRun) {
        const updatedMetadata = { ...metadata, agentId: inferredAgentId };
        await pool.query(
          `UPDATE ${threadsTable} SET metadata = $1 WHERE id = $2`,
          [JSON.stringify(updatedMetadata), thread.id]
        );
      }
      
      inferred++;
      console.log(`  ✅ Thread ${thread.id.slice(0, 8)}... inferred agentId: ${inferredAgentId}`);
    }

    console.log('\n📊 Summary:');
    console.log(`  Already tagged: ${alreadyTagged}`);
    console.log(`  Inferred from ownerId: ${inferred}`);
    console.log(`  Could not infer: ${couldNotInfer}`);
    
    if (couldNotInfer > 0) {
      console.log(`\n  ℹ️  Threads that could not be inferred are missing ownerId or have unexpected format.`);
      console.log(`     These threads will appear in "Older shared chats" for all agents.`);
      console.log(`     They will be tagged to the current agent when a user sends their first message.`);
    }
    
    console.log('\n✅ Backfill complete.');

  } catch (error) {
    console.error('❌ Error during backfill:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backfillChatThreadAgentIds();
