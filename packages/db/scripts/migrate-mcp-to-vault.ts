#!/usr/bin/env tsx

import { db } from '../src';
import { companies, vaultSecrets } from '../src/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import * as fs from 'fs';
import * as path from 'path';

const isDryRun = process.argv.includes('--dry-run');
const skipBackup = process.argv.includes('--skip-backup');

async function migrateCredentials() {
  console.log('=== MCP Credentials → Vault Migration (US-V5 Option A) ===\n');
  
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE — No changes will be made\n');
  }
  
  if (!process.env.VAULT_ENCRYPTION_KEY) {
    console.error('ERROR: VAULT_ENCRYPTION_KEY environment variable not set');
    console.error('Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  
  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  const allCompanies = await db.query.companies.findMany();
  
  console.log(`Found ${allCompanies.length} companies to process\n`);
  
  if (!skipBackup && !isDryRun) {
    const backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFile = path.join(
      backupDir,
      `mcp-credentials-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    
    const backup = allCompanies.map((c) => ({
      id: c.id,
      name: c.name,
      mcpCredentials: (c.settings as any)?.mcpCredentials || {},
    }));
    
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`✓ Backup saved: ${backupFile}\n`);
  }
  
  for (const company of allCompanies) {
    console.log(`Processing company: ${company.name} (${company.id})`);
    
    const settings = company.settings as any;
    const mcpCredentials = settings?.mcpCredentials || {};
    
    if (Object.keys(mcpCredentials).length === 0) {
      console.log('  No MCP credentials to migrate');
      continue;
    }
    
    console.log(`  Found ${Object.keys(mcpCredentials).length} credentials`);
    
    for (const [serverId, credential] of Object.entries(mcpCredentials)) {
      if (!credential || typeof credential !== 'string' || credential.trim() === '') {
        console.log(`  Skipping empty credential for ${serverId}`);
        skippedCount++;
        continue;
      }
      
      try {
        const existing = await db.query.vaultSecrets.findFirst({
          where: and(
            eq(vaultSecrets.companyId, company.id),
            eq(vaultSecrets.serverId, serverId),
            eq(vaultSecrets.scope, 'company')
          ),
        });
        
        if (existing) {
          console.log(`  ✓ Vault entry already exists for ${serverId}, skipping`);
          skippedCount++;
          continue;
        }
        
        const encryptedValue = encryptCredential(credential as string);
        
        if (!isDryRun) {
          await db.insert(vaultSecrets).values({
            companyId: company.id,
            serverId,
            scope: 'company',
            authType: 'api_key',
            encryptedValue,
            needsReauth: false,
          });
        }
        
        console.log(`  ✓ ${isDryRun ? 'Would migrate' : 'Migrated'} credential for ${serverId}`);
        migratedCount++;
      } catch (error) {
        console.error(`  ✗ Failed to migrate ${serverId}:`, error);
        errorCount++;
      }
    }
    
    console.log('');
  }
  
  console.log('\n=== Migration Summary ===');
  console.log(`Migrated: ${migratedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total companies processed: ${allCompanies.length}`);
  
  if (isDryRun) {
    console.log('\n🔍 DRY RUN complete. Run without --dry-run to apply changes.');
    return;
  }
  
  if (errorCount > 0) {
    console.log('\n⚠ Migration completed with errors — NOT clearing legacy field');
    process.exit(1);
  }
  
  console.log('\n✓ Migration completed successfully');
  
  if (migratedCount === 0 && skippedCount === 0) {
    console.log('No credentials to migrate — skipping cleanup');
    return;
  }
  
  console.log('\n=== US-V5 Option A: Clear Legacy Field ===');
  console.log('After verifying vault credentials work, clear settings.mcpCredentials');
  console.log('\nTo clear legacy field, run:');
  console.log('  pnpm db:migrate-mcp --clear-legacy');
  console.log('\nOR manually verify first, then clear with SQL:');
  console.log("  UPDATE companies SET settings = settings - 'mcpCredentials';");
  
  if (process.argv.includes('--clear-legacy')) {
    console.log('\n⚠️  Clearing legacy mcpCredentials field...');
    
    let clearedCount = 0;
    for (const company of allCompanies) {
      const settings = company.settings as any;
      if (settings?.mcpCredentials && Object.keys(settings.mcpCredentials).length > 0) {
        const { mcpCredentials, ...rest } = settings;
        await db
          .update(companies)
          .set({ settings: rest, updatedAt: new Date() })
          .where(eq(companies.id, company.id));
        clearedCount++;
        console.log(`  ✓ Cleared legacy field for ${company.name}`);
      }
    }
    
    console.log(`\n✓ Cleared legacy field from ${clearedCount} companies`);
    console.log('⚠️  Ensure vault resolution is working before deploying!');
  }
}

migrateCredentials()
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
