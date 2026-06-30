'use server';

import { revalidatePath } from 'next/cache';
import {
  CompanyValidationError,
  createCompany,
  getCompanyById,
  setActiveCompanyCookie,
} from '@/lib/company';

export type CreateCompanyResult =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string };

export async function syncActiveCompanyAction(companyId: string): Promise<{ ok: boolean; error?: string }> {
  const company = await getCompanyById(companyId);
  if (!company) {
    return { ok: false, error: 'Company not found.' };
  }

  await setActiveCompanyCookie(company.id);
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function createCompanyAction(formData: FormData): Promise<CreateCompanyResult> {
  if (!(formData instanceof FormData)) {
    return { ok: false, error: 'Invalid form submission.' };
  }

  try {
    const created = await createCompany({
      name: formData.get('name') as string,
      slug: (formData.get('slug') as string) || undefined,
      issuePrefix: (formData.get('issuePrefix') as string) || undefined,
    });
    return { ok: true, id: created.id, name: created.name };
  } catch (err) {
    if (err instanceof CompanyValidationError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
