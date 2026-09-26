import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tourbillon/db';
import { vaultSecrets } from '@tourbillon/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredential, sanitizeForLogging } from '@tourbillon/shared/vault-encryption';
import { getActiveCompany } from '@/lib/company';
import { z } from 'zod';

const createCredentialSchema = z.object({
  serverId: z.string().min(1),
  scope: z.enum(['company', 'company_user', 'agent']),
  authType: z.enum(['api_key', 'oauth']),
  value: z.union([z.string(), z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
  })]),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});

const getCredentialStatusSchema = z.object({
  serverId: z.string().min(1),
  scope: z.enum(['company', 'company_user', 'agent']),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});

const deleteCredentialSchema = z.object({
  serverId: z.string().min(1),
  scope: z.enum(['company', 'company_user', 'agent']),
  userId: z.string().optional(),
  agentId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const company = await getActiveCompany();
    const body = await req.json();
    
    console.log('Creating vault credential:', sanitizeForLogging(body));
    
    const validated = createCredentialSchema.parse(body);
    
    const encryptedValue = encryptCredential(validated.value);
    
    const conditions = [
      eq(vaultSecrets.companyId, company.id),
      eq(vaultSecrets.serverId, validated.serverId),
      eq(vaultSecrets.scope, validated.scope),
    ];
    
    if (validated.scope === 'company_user' && validated.userId) {
      conditions.push(eq(vaultSecrets.userId, validated.userId));
    }
    
    if (validated.scope === 'agent' && validated.agentId) {
      conditions.push(eq(vaultSecrets.agentId, validated.agentId));
    }
    
    const existing = await db.query.vaultSecrets.findFirst({
      where: and(...conditions),
    });
    
    if (existing) {
      await db
        .update(vaultSecrets)
        .set({
          authType: validated.authType,
          encryptedValue,
          needsReauth: false,
          updatedAt: new Date(),
        })
        .where(eq(vaultSecrets.id, existing.id));
      
      return NextResponse.json({ 
        success: true,
        message: 'Credential updated successfully',
      });
    }
    
    await db.insert(vaultSecrets).values({
      companyId: company.id,
      serverId: validated.serverId,
      scope: validated.scope,
      userId: validated.userId,
      agentId: validated.agentId,
      authType: validated.authType,
      encryptedValue,
      needsReauth: false,
    });
    
    return NextResponse.json({ 
      success: true,
      message: 'Credential created successfully',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating vault credential:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to create credential' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const company = await getActiveCompany();
    const { searchParams } = new URL(req.url);
    
    const params = {
      serverId: searchParams.get('serverId'),
      scope: searchParams.get('scope'),
      userId: searchParams.get('userId') || undefined,
      agentId: searchParams.get('agentId') || undefined,
    };
    
    const validated = getCredentialStatusSchema.parse(params);
    
    const conditions = [
      eq(vaultSecrets.companyId, company.id),
      eq(vaultSecrets.serverId, validated.serverId),
      eq(vaultSecrets.scope, validated.scope),
    ];
    
    if (validated.scope === 'company_user' && validated.userId) {
      conditions.push(eq(vaultSecrets.userId, validated.userId));
    }
    
    if (validated.scope === 'agent' && validated.agentId) {
      conditions.push(eq(vaultSecrets.agentId, validated.agentId));
    }
    
    const credential = await db.query.vaultSecrets.findFirst({
      where: and(...conditions),
    });
    
    return NextResponse.json({
      serverId: validated.serverId,
      configured: !!credential,
      needsReauth: credential?.needsReauth ?? false,
      authType: credential?.authType,
    });
  } catch (error) {
    console.error('Error getting credential status:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to get credential status' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const company = await getActiveCompany();
    const body = await req.json();
    
    const validated = deleteCredentialSchema.parse(body);
    
    const conditions = [
      eq(vaultSecrets.companyId, company.id),
      eq(vaultSecrets.serverId, validated.serverId),
      eq(vaultSecrets.scope, validated.scope),
    ];
    
    if (validated.scope === 'company_user' && validated.userId) {
      conditions.push(eq(vaultSecrets.userId, validated.userId));
    }
    
    if (validated.scope === 'agent' && validated.agentId) {
      conditions.push(eq(vaultSecrets.agentId, validated.agentId));
    }
    
    const credential = await db.query.vaultSecrets.findFirst({
      where: and(...conditions),
    });
    
    if (!credential) {
      return NextResponse.json(
        { error: 'Credential not found' },
        { status: 404 }
      );
    }
    
    await db.delete(vaultSecrets).where(eq(vaultSecrets.id, credential.id));
    
    return NextResponse.json({ 
      success: true,
      message: 'Credential deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting vault credential:', error);
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.errors },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to delete credential' },
      { status: 500 }
    );
  }
}
