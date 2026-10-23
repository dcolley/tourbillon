import { NextRequest, NextResponse } from 'next/server';
import { db, agents, llmProviderDisabledForCompanyMessage } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import {
  effectiveLlmProviderIdForCompany,
  getDefaultLlmProviderRecord,
  getLlmProviderRecordById,
  isLlmProviderOnForCompany,
} from '@/lib/llm-providers';
import {
  listProviderModelsForAgent,
  listProviderModelsForRecord,
} from '@/lib/model-catalog';
import { defaultProviderModelsResponse } from '@/lib/default-provider-models';
import { ProviderConfigError, redactUrlsInText } from '@/lib/provider-safety';
import {
  activeBoardCompanyOrNull,
  requireBoardCompany,
  requireBoardIdentity,
} from '@/lib/board-route-auth';

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agentId');
  const providerId = req.nextUrl.searchParams.get('providerId');
  // PRV-1: the provider settings page lists every provider (with its switch), so it may ask for
  // the models of a provider that is switched off for the company. Pickers do not.
  const includeDisabled = req.nextUrl.searchParams.get('includeDisabled') === '1';

  // #106: board only. Agent-scoped lookups are limited to the board's company (other → 404).
  const auth = agentId && !providerId ? await requireBoardCompany(req) : await requireBoardIdentity(req);
  if (!auth.ok) return auth.response;

  try {
    if (providerId) {
      const record = await getLlmProviderRecordById(providerId);
      if (!record) {
        return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      }
      if (!includeDisabled) {
        const company = await activeBoardCompanyOrNull(req);
        if (company && !(await isLlmProviderOnForCompany(company.id, record.id))) {
          return NextResponse.json(
            {
              error: llmProviderDisabledForCompanyMessage(record.name),
              code: 'provider_disabled_for_company',
            },
            { status: 409 },
          );
        }
      }
      const result = await listProviderModelsForRecord(record);
      return NextResponse.json(result);
    }

    if (agentId) {
      const companyId = auth.value === true ? null : auth.value.id;
      if (!companyId) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
      });
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }

      // #121 S7: same order as the default path: the agent's provider, else the registry
      // default, and env only when the registry has no default.
      // PRV-1: a provider switched off for the company moves to the company default, as runs do.
      const effectiveId = await effectiveLlmProviderIdForCompany(companyId, agent.providerId);
      const providerRecord =
        (effectiveId ? await getLlmProviderRecordById(effectiveId) : null) ??
        (agent.providerId ? await getLlmProviderRecordById(agent.providerId) : null) ??
        (await getDefaultLlmProviderRecord());

      const result = await listProviderModelsForAgent(
        agent.adapterType,
        agent.adapterConfig,
        agent.modelId,
        providerRecord,
      );
      return NextResponse.json(result);
    }

    // PRV-1: when the registry default is switched off for the company, list the company
    // default's models instead.
    const company = await activeBoardCompanyOrNull(req);
    if (company) {
      const registryDefault = await getDefaultLlmProviderRecord();
      const effectiveId = await effectiveLlmProviderIdForCompany(company.id, null);
      if (registryDefault && effectiveId && effectiveId !== registryDefault.id) {
        const record = await getLlmProviderRecordById(effectiveId);
        if (record) return NextResponse.json(await listProviderModelsForRecord(record));
      }
    }

    // Registry default provider first, env only when there is no default; clear 409/502/503 JSON
    // errors instead of a bare 502 (see lib/default-provider-models.ts).
    return await defaultProviderModelsResponse();
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof Error && err.name === 'NoEnabledLlmProviderError') {
      return NextResponse.json(
        { error: err.message, code: 'no_provider_enabled_for_company' },
        { status: 409 },
      );
    }
    const message = redactUrlsInText(err instanceof Error ? err.message : 'Failed to list models');
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
