import { db, issues, activityLog, agents } from '@tourbillon/db';
import { and, eq, or, ilike, desc, gte, sql, inArray } from 'drizzle-orm';
import {
  getCompanyWorkspaceDir,
  listWorkspaceEntries,
  readWorkspaceText,
  isTextEditablePath,
  type WorkspaceEntry,
} from '@tourbillon/shared/company-workspace';
import path from 'path';

export interface SearchHit {
  type: 'issue' | 'comment' | 'document';
  id: string;
  issueId?: string;
  identifier?: string;
  title: string;
  snippet: string;
  status?: string;
  updatedAt: string;
  href?: string;
}

export interface SearchOptions {
  companyId: string;
  q: string;
  types?: ('issue' | 'comment' | 'document')[];
  status?: string;
  assignee?: string;
  createdAfter?: string;
  limit?: number;
}

interface RankedHit extends SearchHit {
  relevance: number;
  timestamp: Date;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_LENGTH = 200;

function extractSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  
  if (index === -1) {
    // No exact match, return first N chars
    return text.substring(0, SNIPPET_LENGTH).trim() + (text.length > SNIPPET_LENGTH ? '...' : '');
  }
  
  // Center snippet around the match
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + query.length + 150);
  const snippet = text.substring(start, end).trim();
  
  return (start > 0 ? '...' : '') + snippet + (end < text.length ? '...' : '');
}

function calculateRelevance(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  
  let score = 0;
  
  // Exact phrase match (highest)
  if (lowerText.includes(lowerQuery)) {
    score += 100;
    // Bonus for position (earlier is better)
    const position = lowerText.indexOf(lowerQuery);
    score += Math.max(0, 50 - position / 10);
  }
  
  // Token matches
  const queryTokens = lowerQuery.split(/\s+/).filter(Boolean);
  for (const token of queryTokens) {
    if (lowerText.includes(token)) {
      score += 10;
    }
  }
  
  return score;
}

async function searchIssues(
  companyId: string,
  query: string,
  status?: string,
  assignee?: string,
  createdAfter?: string
): Promise<RankedHit[]> {
  const conditions = [eq(issues.companyId, companyId)];
  
  // Text search conditions
  const searchPattern = `%${query}%`;
  const textConditions = [
    ilike(issues.identifier, searchPattern),
    ilike(issues.title, searchPattern),
    ilike(issues.description ?? '', searchPattern),
    ilike(issues.planDocumentBody ?? '', searchPattern),
  ];
  conditions.push(or(...textConditions)!);
  
  // Optional filters
  if (status) {
    conditions.push(eq(issues.status, status));
  }
  if (assignee) {
    // Support both agent ID and urlKey
    const agentRecord = await db.query.agents.findFirst({
      where: or(eq(agents.id, assignee), eq(agents.urlKey, assignee)),
    });
    if (agentRecord) {
      conditions.push(eq(issues.assigneeAgentId, agentRecord.id));
    } else {
      // Unknown assignee - return no matches
      return [];
    }
  }
  if (createdAfter) {
    conditions.push(gte(issues.createdAt, new Date(createdAfter)));
  }
  
  const results = await db
    .select()
    .from(issues)
    .where(and(...conditions));
  
  return results.map((issue): RankedHit => {
    const searchableText = [
      issue.identifier,
      issue.title,
      issue.description ?? '',
      issue.planDocumentBody ?? '',
    ].join(' ');
    
    const relevance = calculateRelevance(searchableText, query);
    const snippet = extractSnippet(
      issue.description || issue.title || issue.identifier,
      query
    );
    
    return {
      type: 'issue',
      id: issue.id,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      snippet,
      status: issue.status,
      updatedAt: issue.updatedAt.toISOString(),
      href: `/issue/${issue.id}`,
      relevance,
      timestamp: issue.updatedAt,
    };
  });
}

async function searchComments(
  companyId: string,
  query: string,
  createdAfter?: string
): Promise<RankedHit[]> {
  const conditions = [
    eq(activityLog.companyId, companyId),
    eq(activityLog.entityType, 'issue'),
    eq(activityLog.action, 'issue.commented'),
  ];
  
  if (createdAfter) {
    conditions.push(gte(activityLog.createdAt, new Date(createdAfter)));
  }
  
  // Search in comment body fields
  const searchPattern = `%${query}%`;
  conditions.push(
    or(
      sql`${activityLog.details}->>'comment' ILIKE ${searchPattern}`,
      sql`${activityLog.details}->>'body' ILIKE ${searchPattern}`
    )!
  );
  
  const comments = await db
    .select()
    .from(activityLog)
    .where(and(...conditions));
  
  // Join with parent issues
  const issueIds = [...new Set(comments.map(c => c.entityId))];
  if (issueIds.length === 0) {
    return [];
  }
  
  const parentIssues = await db
    .select()
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.id, issueIds)
    ));
  
  const issueMap = new Map(parentIssues.map(i => [i.id, i]));
  
  return comments
    .map((comment): RankedHit | null => {
      const details = (comment.details ?? {}) as Record<string, unknown>;
      const commentBody = (details.comment || details.body || '') as string;
      
      if (!commentBody.trim()) return null;
      
      const parentIssue = issueMap.get(comment.entityId);
      if (!parentIssue) return null;
      
      const relevance = calculateRelevance(commentBody, query);
      const snippet = extractSnippet(commentBody, query);
      
      return {
        type: 'comment',
        id: comment.id,
        issueId: parentIssue.id,
        identifier: parentIssue.identifier,
        title: parentIssue.title,
        snippet,
        status: parentIssue.status,
        updatedAt: comment.createdAt.toISOString(),
        href: `/issue/${parentIssue.id}#comment-${comment.id}`,
        relevance,
        timestamp: comment.createdAt,
      };
    })
    .filter((hit): hit is RankedHit => hit !== null);
}

async function searchDocuments(
  companyId: string,
  query: string,
  createdAfter?: string
): Promise<RankedHit[]> {
  const hits: RankedHit[] = [];
  
  try {
    const workspaceDir = getCompanyWorkspaceDir(companyId);
    
    // List all entries recursively
    const allEntries = await listWorkspaceEntries(companyId, { recursive: true });
    
    // Filter to text-editable files, exclude agents/ and skills/
    const textFiles = allEntries.filter((entry: WorkspaceEntry) => {
      if (entry.type !== 'file') return false;
      if (!isTextEditablePath(entry.path)) return false;
      
      // Exclude agent private dirs and skills
      const pathSegments = entry.path.split('/');
      if (pathSegments[0] === 'agents') return false;
      if (pathSegments[0] === 'skills') return false;
      
      // Apply date filter if provided
      if (createdAfter && entry.updatedAt) {
        const entryDate = new Date(entry.updatedAt);
        const filterDate = new Date(createdAfter);
        if (entryDate < filterDate) return false;
      }
      
      return true;
    });
    
    // Search file contents
    for (const entry of textFiles) {
      try {
        const { content } = await readWorkspaceText(companyId, entry.path);
        const lowerContent = content.toLowerCase();
        const lowerQuery = query.toLowerCase();
        
        if (lowerContent.includes(lowerQuery)) {
          const relevance = calculateRelevance(content, query);
          const snippet = extractSnippet(content, query);
          const title = entry.name || path.basename(entry.path);
          
          hits.push({
            type: 'document',
            id: entry.path,
            title,
            snippet,
            updatedAt: entry.updatedAt || new Date().toISOString(),
            href: `/workspace/${entry.path}`,
            relevance,
            timestamp: new Date(entry.updatedAt || Date.now()),
          });
        }
      } catch (err) {
        // Skip unreadable files
        console.warn(`Failed to read workspace file ${entry.path}:`, err);
      }
    }
  } catch (err) {
    // Workspace might not exist yet or be inaccessible
    console.warn(`Failed to search workspace for company ${companyId}:`, err);
  }
  
  return hits;
}

export async function searchCompanyText(options: SearchOptions): Promise<{ results: SearchHit[] }> {
  const { companyId, q, types, status, assignee, createdAfter } = options;
  let { limit } = options;
  
  // Validate query
  if (!q || !q.trim()) {
    throw new Error('Search query (q) is required and cannot be empty');
  }
  
  // Validate and clamp limit
  limit = limit ?? DEFAULT_LIMIT;
  if (limit < 1 || limit > MAX_LIMIT) {
    limit = Math.min(Math.max(1, limit), MAX_LIMIT);
  }
  
  // Determine which sources to search
  const searchTypes = types && types.length > 0 ? types : ['issue', 'comment', 'document'];
  
  const allHits: RankedHit[] = [];
  
  // Search issues
  if (searchTypes.includes('issue')) {
    const issueHits = await searchIssues(companyId, q, status, assignee, createdAfter);
    allHits.push(...issueHits);
  }
  
  // Search comments
  if (searchTypes.includes('comment')) {
    const commentHits = await searchComments(companyId, q, createdAfter);
    allHits.push(...commentHits);
  }
  
  // Search documents
  if (searchTypes.includes('document')) {
    const documentHits = await searchDocuments(companyId, q, createdAfter);
    allHits.push(...documentHits);
  }
  
  // Sort by relevance (desc), then timestamp (desc)
  allHits.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return b.relevance - a.relevance;
    }
    return b.timestamp.getTime() - a.timestamp.getTime();
  });
  
  // Take top N and remove ranking metadata
  const results: SearchHit[] = allHits.slice(0, limit).map(hit => {
    const { relevance, timestamp, ...searchHit } = hit;
    return searchHit;
  });
  
  return { results };
}
