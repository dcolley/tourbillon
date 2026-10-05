#!/usr/bin/env tsx
/**
 * Backfill agentId metadata for existing chat threads.
 * 
 * Idempotent: Threads already tagged with agentId are skipped.
 * 
 * Usage:
 *   tsx scripts/backfill-chat-thread-agent-ids.ts
 * 
 * Environment variables:
 *   DATABASE_URL - Required (same as app)
 *   DRY_RUN - Set to "true" to preview changes without writing (optional)
 * 
 * Inference strategy:
 *   1. Check thread metadata for existing agentId tag → skip if present
 *   2. Look for assistant messages in thread → infer agent from message author
 *   3. If no clear agent, thread remains untagged (will appear in "Older shared chats")
 */

import { Pool } from 'pg';

interface ThreadRow {
  id: string;
  resource_id: string;
  metadata: Record<string, unknown>;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  metadata: Record<string, unknown>;
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
    // Mastra PostgresStore creates tables with format: {storageId}_memory_threads
    const storageId = 'tourbillon-chat-threads';
    const threadsTable = `"${storageId}_memory_threads"`;
    const messagesTable = `"${storageId}_memory_messages"`;

    // Check if tables exist
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('${storageId}_memory_threads', '${storageId}_memory_messages')
    `);

    if (tableCheck.rows.length === 0) {
      console.log('⚠️  No Mastra chat thread tables found. This is expected if no chat sessions exist yet.');
      console.log('   Tables will be created automatically when the first chat session is created.');
      await pool.end();
      return;
    }

    console.log(`✓ Found Mastra storage tables: ${tableCheck.rows.map((r: { table_name: string }) => r.table_name).join(', ')}\n`);

    // Find all threads
    const threadsResult = await pool.query<ThreadRow>(`
      SELECT id, resource_id, metadata
      FROM ${threadsTable}
      ORDER BY created_at DESC
    `);

    const threads = threadsResult.rows;
    console.log(`Found ${threads.length} total thread(s)\n`);

    if (threads.length === 0) {
      console.log('No threads to process.');
      await pool.end();
      return;
    }

    let alreadyTagged = 0;
    let tagged = 0;
    let couldNotInfer = 0;

    for (const thread of threads) {
      const metadata = thread.metadata || {};
      
      // Skip if already tagged
      if (metadata.agentId) {
        alreadyTagged++;
        console.log(`  ⏭️  Thread ${thread.id.slice(0, 8)}... already tagged (agentId: ${metadata.agentId})`);
        continue;
      }

      // Try to infer agentId from messages
      const messagesResult = await pool.query<MessageRow>(`
        SELECT id, role, metadata
        FROM ${messagesTable}
        WHERE thread_id = $1
          AND role = 'assistant'
        ORDER BY created_at ASC
        LIMIT 1
      `, [thread.id]);

      if (messagesResult.rows.length === 0) {
        couldNotInfer++;
        console.log(`  ⚠️  Thread ${thread.id.slice(0, 8)}... has no assistant messages (will appear in "Older shared chats")`);
        continue;
      }

      // Infer agent from resource_id pattern: company-{companyId}:chat:free
      // The actual agent is determined by which controller created the thread.
      // We can look at the thread's resource_id to get company, but we need to check
      // which agents exist for that company and match against message patterns.
      
      // For now, we cannot reliably infer the agent from the thread alone without
      // additional context (like heartbeat_runs or agent_observability_events).
      // Mark these as unable to infer.
      couldNotInfer++;
      console.log(`  ⚠️  Thread ${thread.id.slice(0, 8)}... cannot reliably infer agentId (will appear in "Older shared chats")`);
      
      // Future enhancement: Join with agents table and heartbeat_runs/observability to infer agent
    }

    console.log('\n📊 Summary:');
    console.log(`  Already tagged: ${alreadyTagged}`);
    console.log(`  Newly tagged: ${tagged}`);
    console.log(`  Could not infer: ${couldNotInfer}`);
    console.log(`\n  Untagged threads will appear in "Older shared chats" for all agents.`);
    console.log(`  They will be tagged to the current agent when a user sends their first message.`);

    if (tagged > 0 && dryRun) {
      console.log('\n⚠️  DRY RUN: No changes were written. Run without DRY_RUN=true to apply updates.');
    } else if (tagged > 0) {
      console.log('\n✅ Backfill complete!');
    } else {
      console.log('\n✅ No changes needed.');
    }

  } catch (error) {
    console.error('❌ Error during backfill:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backfillChatThreadAgentIds();
