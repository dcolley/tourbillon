import { db, companies, type Company } from '@tourbillon/db';
import { ensureCompanyWorkspace } from '@tourbillon/shared';
import { eq } from 'drizzle-orm';

export async function getOrCreateDefaultCompany(): Promise<Company> {
  const existing = await db.query.companies.findFirst();
  if (existing) {
    await ensureCompanyWorkspace(existing.id);
    return existing;
  }

  const [created] = await db
    .insert(companies)
    .values({
      name: 'Tourbillon',
      slug: 'default',
      issuePrefix: 'TOUR',
      requiresBoardApprovalForHires: true,
    })
    .returning();

  await ensureCompanyWorkspace(created.id);
  return created;
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
