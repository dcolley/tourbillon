#!/usr/bin/env tsx

import { db } from '../src';
import { companies, vaultSecrets } from '../src/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';

async function migrateCredentials() {
  console.log('Starting MCP credentials migration to vault...\n');
  
  if (!process.env.VAULT_ENCRYPTION_KEY) {
    console.error('ERROR: VAULT_ENCRYPTION_KEY environment variable not set');
    process.exit(1);
  }
  
  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  const allCompanies = await db.query.companies.findMany();
  
  console.log(`Found ${allCompanies.length} companies to process\n`);
  
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
        
        await db.insert(vaultSecrets).values({
          companyId: company.id,
          serverId,
          scope: 'company',
          authType: 'api_key',
          encryptedValue,
          needsReauth: false,
        });
        
        console.log(`  ✓ Migrated credential for ${serverId}`);
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
  
  if (errorCount > 0) {
    console.log('\n⚠ Migration completed with errors');
    process.exit(1);
  } else {
    console.log('\n✓ Migration completed successfully');
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
