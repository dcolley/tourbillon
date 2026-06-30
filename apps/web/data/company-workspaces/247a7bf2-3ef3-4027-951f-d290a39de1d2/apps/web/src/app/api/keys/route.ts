// ============================================================================
// TOUR-115: API Keys Management — CRUD Operations
// 
// GET    /api/keys  - List all API keys for the current user
// POST   /api/keys  - Create a new API key
// ============================================================================

import { NextResponse } from 'next/server';

interface ApiKeyData {
  id: string;
  name?: string;
  prefix: string; // e.g., "sk_live_" or "pk_live_"
  maskedKey: string; // First 8 chars of the key, shown in UI
  createdAt: Date;
  lastUsedAt?: Date | null;
  permissions: string[];
  environment: 'live' | 'test';
  active: boolean;
}

// In-memory store for API keys (replace with DB for production)
const apiKeysStore = new Map<string, ApiKeyData>();
let keyCounter = 0;

/**
 * Generate a random API key prefix + key string
 */
function generateApiKey(environment: 'live' | 'test'): { fullKey: string; prefix: string; maskedKey: string } {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const prefix = environment === 'live' ? 'sk_live_' : 'sk_test_';
  
  // Generate a realistic-looking key (e.g., sk_live_4eC39HjLyXJrDt)
  let randomPart = '';
  for (let i = 0; i < 24; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  const fullKey = prefix + randomPart;
  const maskedKey = randomPart.substring(0, 8);
  
  return { fullKey, prefix, maskedKey };
}

/**
 * GET - List all API keys for the current user
 */
export async function GET(): Promise<NextResponse> {
  try {
    // In production, this would fetch from database filtered by userId
    const keys = Array.from(apiKeysStore.values());
    
    return NextResponse.json({ 
      keys: keys.map(key => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        maskedKey: key.maskedKey,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        permissions: key.permissions,
        environment: key.environment,
        active: key.active,
      }))
    });
  } catch (error) {
    console.error('[API KEYS] Error listing keys:', error);
    return NextResponse.json(
      { error: 'Failed to fetch API keys' },
      { status: 500 }
    );
  }
}

/**
 * POST - Create a new API key
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { name, permissions, environment }: { 
      name?: string; 
      permissions: string[]; 
      environment: 'live' | 'test';
    } = body;

    // Validate required fields
    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return NextResponse.json(
        { error: 'Permissions array is required and must contain at least one permission' },
        { status: 400 }
      );
    }

    const validPermissions = ['Goals', 'Issues', 'Projects', 'Tokens', 'Read-only'];
    for (const perm of permissions) {
      if (!validPermissions.includes(perm)) {
        return NextResponse.json(
          { error: `Invalid permission: ${perm}` },
          { status: 400 }
        );
      }
    }

    const env = environment || 'test'; // Default to test environment
    
    // Generate the API key
    const { fullKey, prefix, maskedKey } = generateApiKey(env);
    
    // Create the key object
    const newKey: ApiKeyData = {
      id: `key_${++keyCounter}`,
      name,
      prefix,
      maskedKey,
      createdAt: new Date(),
      lastUsedAt: null,
      permissions,
      environment: env,
      active: true,
    };

    // Store in memory (in production, save to database)
    apiKeysStore.set(newKey.id, newKey);

    console.log('[API KEYS] Created API key ' + newKey.id + ' for user');

    // Return the full key only once (client should store it securely)
    return NextResponse.json({ 
      message: 'API key created successfully',
      id: newKey.id,
      name: newKey.name,
      prefix: newKey.prefix,
      environment: newKey.environment,
      permissions: newKey.permissions,
      active: true,
      createdAt: newKey.createdAt,
      key: fullKey, // Only shown once during creation
    }, { status: 201 });
  } catch (error) {
    console.error('[API KEYS] Error creating key:', error);
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    );
  }
}
