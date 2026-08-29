import { NextRequest, NextResponse } from 'next/server';
import { db, issues } from '@tourbillon/db';
import { eq, desc, inArray } from 'drizzle-orm';
import { getActiveCompanyOrNull } from '@/lib/company';
import type { IssueStatus } from '@tourbillon/db';

/**
 * GET /api/mobile/companies/[companyId]/issues
 * List issues for a company (active issues only)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> }
) {
  try {
    const { companyId } = await params;
    
    // Verify active company matches requested company
    const activeCompany = await getActiveCompanyOrNull();
    if (!activeCompany || activeCompany.id !== companyId) {
      return NextResponse.json(
        { error: 'Company not selected or mismatch' },
        { status: 403 }
      );
    }
    
    // Fetch active issues (not done/cancelled)
    const activeStatuses: IssueStatus[] = ['todo', 'in_progress', 'in_review', 'blocked'];
    
    const companyIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        parentId: issues.parentId,
        goalId: issues.goalId,
        assigneeAgentId: issues.assigneeAgentId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(eq(issues.companyId, companyId))
      .orderBy(desc(issues.updatedAt))
      .limit(100);
    
    return NextResponse.json(
      companyIssues.map((issue) => ({
        ...issue,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error('Mobile API: Failed to list issues:', error);
    return NextResponse.json(
      { error: 'Failed to load issues' },
      { status: 500 }
    );
  }
}
