import { db } from './client';
import { llmProviders, type LlmProvider } from './schema/llm-providers';
import { asc, eq } from 'drizzle-orm';

export type LlmProviderRow = LlmProvider;

export async function getLlmProviderRowById(id: string): Promise<LlmProvider | null> {
  return (
    (await db.query.llmProviders.findFirst({ where: eq(llmProviders.id, id) })) ?? null
  );
}

export async function getDefaultLlmProviderRow(): Promise<LlmProvider | null> {
  return (
    (await db.query.llmProviders.findFirst({
      where: eq(llmProviders.isDefault, true),
    })) ?? null
  );
}

export async function listLlmProviderRows(): Promise<LlmProvider[]> {
  return db.select().from(llmProviders).orderBy(asc(llmProviders.name));
}
