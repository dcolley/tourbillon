import { NextRequest, NextResponse } from 'next/server';
import {
  isHitlyGateConfigured,
  isSearxngConfigured,
  isTavilyConfigured,
  parseCompanySettings,
} from '@tourbillon/shared';
import { listLlmProvidersPublic } from '@/lib/llm-providers';
import { requireMobileCompany } from '@/lib/mobile-session';

export async function GET(req: NextRequest) {
  const auth = await requireMobileCompany(req);
  if ('error' in auth) return auth.error;

  try {
    const settings = parseCompanySettings(auth.company.settings);
    const providers = await listLlmProvidersPublic();
    return NextResponse.json({
      company: {
        id: auth.company.id,
        name: auth.company.name,
        slug: auth.company.slug,
        issuePrefix: auth.company.issuePrefix,
        requiresBoardApprovalForHires: auth.company.requiresBoardApprovalForHires,
        budgetMonthlyTokens: auth.company.budgetMonthlyTokens,
      },
      integrations: {
        searxng: isSearxngConfigured(settings),
        tavily: isTavilyConfigured(settings),
        hitly: isHitlyGateConfigured(settings),
        buffer: Boolean(settings.mcpCredentials?.['buffer-mcp']),
      },
      observationalMemory: {
        enabled: settings.observationalMemory?.enabled === true,
        modelId: settings.observationalMemory?.modelId ?? null,
        providerId: settings.observationalMemory?.providerId ?? null,
      },
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        isDefault: p.isDefault,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
