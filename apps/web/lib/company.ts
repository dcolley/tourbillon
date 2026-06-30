import { cookies } from 'next/headers';
import { db, companies, type Company } from '@tourbillon/db';
import { ensureCompanyWorkspace, mergeCompanySettings, parseCompanySettings, type CompanySettings } from '@tourbillon/shared';
import { asc, eq } from 'drizzle-orm';
import { deriveIssuePrefix, slugifyCompanySlug } from './company-utils';

export const ACTIVE_COMPANY_COOKIE = 'active_company_id';

export class ActiveCompanyError extends Error {
  constructor(message = 'No active company selected.') {
    super(message);
    this.name = 'ActiveCompanyError';
  }
}

export async function setActiveCompanyCookie(companyId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COMPANY_COOKIE, companyId, {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveCompanyCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_COMPANY_COOKIE);
}

export async function getCompanyById(companyId: string): Promise<Company | null> {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
  });
  if (!company) return null;
  await ensureCompanyWorkspace(company.id);
  return company;
}

export async function getActiveCompanyOrNull(): Promise<Company | null> {
  const cookieStore = await cookies();
  const companyId = cookieStore.get(ACTIVE_COMPANY_COOKIE)?.value;
  if (!companyId) return null;
  return getCompanyById(companyId);
}

export async function getActiveCompany(): Promise<Company> {
  const company = await getActiveCompanyOrNull();
  if (!company) throw new ActiveCompanyError();
  return company;
}

export async function listCompanies(): Promise<Company[]> {
  return db.select().from(companies).orderBy(asc(companies.name));
}

export interface CreateCompanyInput {
  name: string;
  slug?: string;
  issuePrefix?: string;
}

export class CompanyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyValidationError';
  }
}

export async function createCompany(input: CreateCompanyInput): Promise<Company> {
  const name = input.name?.trim();
  if (!name) throw new CompanyValidationError('Company name is required.');

  const slug = slugifyCompanySlug(input.slug?.trim() || name);
  if (!slug) throw new CompanyValidationError('Company slug is required.');

  const issuePrefix = (input.issuePrefix?.trim() || deriveIssuePrefix(name)).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(issuePrefix)) {
    throw new CompanyValidationError('Issue prefix must be uppercase letters and numbers only.');
  }

  const existingSlug = await db.query.companies.findFirst({
    where: eq(companies.slug, slug),
  });
  if (existingSlug) {
    throw new CompanyValidationError(`Slug "${slug}" is already in use.`);
  }

  const [created] = await db
    .insert(companies)
    .values({
      name,
      slug,
      issuePrefix,
      requiresBoardApprovalForHires: true,
    })
    .returning();

  await ensureCompanyWorkspace(created.id);
  return created;
}

export async function getOrCreateDefaultCompany(): Promise<Company> {
  const existing = await db.query.companies.findFirst();
  if (existing) {
    await ensureCompanyWorkspace(existing.id);
    return existing;
  }

  return createCompany({
    name: 'Tourbillon',
    slug: 'default',
    issuePrefix: 'TOUR',
  });
}

export async function updateCompanySettings(
  companyId: string,
  input: {
    name: string;
    issuePrefix: string;
    requiresBoardApprovalForHires: boolean;
    budgetMonthlyTokens: number;
  }
): Promise<Company> {
  const name = input.name.trim();
  const issuePrefix = input.issuePrefix.trim().toUpperCase();

  if (!name) throw new Error('Company name is required.');
  if (!issuePrefix || !/^[A-Z0-9]+$/.test(issuePrefix)) {
    throw new Error('Issue prefix must be uppercase letters and numbers only.');
  }
  if (input.budgetMonthlyTokens < 1) {
    throw new Error('Monthly token budget must be at least 1.');
  }

  const [updated] = await db
    .update(companies)
    .set({
      name,
      issuePrefix,
      requiresBoardApprovalForHires: input.requiresBoardApprovalForHires,
      budgetMonthlyTokens: input.budgetMonthlyTokens,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId))
    .returning();

  if (!updated) throw new Error('Company not found.');
  return updated;
}

export async function updateCompanyIntegrations(
  companyId: string,
  input: {
    searxngUrl?: string;
    searxngApiKey?: string;
    bufferApiKey?: string;
    clearBufferApiKey?: boolean;
    clearSearxngApiKey?: boolean;
  },
): Promise<Company> {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error('Company not found.');

  const current = parseCompanySettings(company.settings);
  const patch: Partial<CompanySettings> = {};

  if (input.searxngUrl !== undefined) {
    patch.searxngUrl = input.searxngUrl.trim();
  }

  if (input.clearSearxngApiKey) {
    patch.searxngApiKey = '';
  } else if (input.searxngApiKey !== undefined && input.searxngApiKey.trim()) {
    patch.searxngApiKey = input.searxngApiKey.trim();
  }

  const mcpCredentials = { ...current.mcpCredentials };
  if (input.clearBufferApiKey) {
    delete mcpCredentials['buffer-mcp'];
  } else if (input.bufferApiKey !== undefined && input.bufferApiKey.trim()) {
    mcpCredentials['buffer-mcp'] = input.bufferApiKey.trim();
  }
  if (Object.keys(mcpCredentials).length > 0) {
    patch.mcpCredentials = mcpCredentials;
  } else if (input.clearBufferApiKey) {
    patch.mcpCredentials = {};
  }

  const settings = mergeCompanySettings(company.settings, patch);

  const [updated] = await db
    .update(companies)
    .set({ settings, updatedAt: new Date() })
    .where(eq(companies.id, companyId))
    .returning();

  if (!updated) throw new Error('Company not found.');
  return updated;
}

export function assertCompanyAccess(entityCompanyId: string, activeCompanyId: string): void {
  if (entityCompanyId !== activeCompanyId) {
    throw new ActiveCompanyError('This resource belongs to a different company.');
  }
}
