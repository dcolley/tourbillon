import { NextRequest, NextResponse } from 'next/server';
import { validateRunToken } from '@/lib/auth/run-token';
import { verifyMobileToken } from '@/lib/mobile-auth';
import { searchCompanyText, type SearchOptions } from '@/lib/search';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  types: z.array(z.enum(['issue', 'comment', 'document'])).optional(),
  status: z.string().optional(),
  assignee: z.string().optional(),
  createdAfter: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  
  // Support both agent run-token and board/mobile JWT
  const authHeader = req.headers.get('authorization');
  let authenticatedCompanyId: string | null = null;
  
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    
    // Try run token first (agent auth)
    const runCtx = validateRunToken(token);
    if (runCtx) {
      authenticatedCompanyId = runCtx.companyId;
    } else {
      // Try mobile/board JWT
      const mobilePayload = verifyMobileToken(token);
      if (mobilePayload) {
        authenticatedCompanyId = mobilePayload.companyId;
      }
    }
  }
  
  if (!authenticatedCompanyId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // Verify company ID matches
  if (authenticatedCompanyId !== companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  // Parse query parameters
  const url = new URL(req.url);
  const queryParams: Record<string, unknown> = {
    q: url.searchParams.get('q'),
  };
  
  const typesParam = url.searchParams.get('types');
  if (typesParam) {
    // Support both comma-separated string and array
    queryParams.types = typesParam.split(',').map(t => t.trim());
  }
  
  if (url.searchParams.has('status')) {
    queryParams.status = url.searchParams.get('status');
  }
  if (url.searchParams.has('assignee')) {
    queryParams.assignee = url.searchParams.get('assignee');
  }
  if (url.searchParams.has('createdAfter')) {
    queryParams.createdAfter = url.searchParams.get('createdAfter');
  }
  if (url.searchParams.has('limit')) {
    queryParams.limit = url.searchParams.get('limit');
  }
  
  // Validate query parameters
  const validation = searchQuerySchema.safeParse(queryParams);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Validation error', details: validation.error.errors },
      { status: 400 }
    );
  }
  
  const searchParams = validation.data;
  
  try {
    const options: SearchOptions = {
      companyId,
      q: searchParams.q,
      types: searchParams.types,
      status: searchParams.status,
      assignee: searchParams.assignee,
      createdAfter: searchParams.createdAfter,
      limit: searchParams.limit,
    };
    
    const results = await searchCompanyText(options);
    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    // Handle validation errors from the search function
    if (message.includes('required') || message.includes('cannot be empty')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    
    console.error('Search error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
