import {
  parseEgressAllowListMode,
  resolveEgressAllowListInput,
  sanitizeEgressAllowList,
  type AgentRuntimeConfig,
  type AgentRuntimeType,
  type SandboxIsolation,
} from '@tourbillon/shared';

const VALID_SANDBOX_ISOLATION = new Set<SandboxIsolation>(['none', 'seatbelt', 'bwrap']);

export type CodeExecutionUpdateInput = {
  runtimeType: AgentRuntimeType;
  codeExecutionEnabled: boolean;
  timeoutMs?: number | null;
  isolation?: string | null;
  allowNetwork?: boolean | null;
  egressAllowList?: string[] | null;
  clearCodeExecutionOverrides?: boolean;
};

export function parseCodeExecutionFormData(formData: FormData): {
  agentId: string;
  urlKey: string;
  timeoutMs?: number;
  timeoutRaw: string;
  input: Omit<CodeExecutionUpdateInput, 'runtimeType' | 'codeExecutionEnabled'> & {
    runtimeType: 'agent' | 'harness';
    codeExecutionEnabled: boolean;
  };
} {
  const agentId = String(formData.get('agentId') ?? '');
  const urlKey = String(formData.get('urlKey') ?? '');
  const runtimeType = (formData.get('runtimeType') as 'agent' | 'harness') || 'agent';
  const codeExecutionEnabled = formData.get('codeExecutionEnabled') === 'on';
  const timeoutRaw = (formData.get('codeExecutionTimeoutMs') as string)?.trim() ?? '';
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const isolation = (formData.get('codeExecutionIsolation') as string) || null;
  const mode = parseEgressAllowListMode(formData.get('egressAllowListMode'));
  const entries = formData.getAll('egressAllowList').map(String);
  const egressAllowList = resolveEgressAllowListInput(mode, entries);

  return {
    agentId,
    urlKey,
    timeoutMs,
    timeoutRaw,
    input: {
      runtimeType,
      codeExecutionEnabled,
      timeoutMs: timeoutRaw ? timeoutMs : undefined,
      isolation,
      allowNetwork: mode === 'off' ? formData.get('codeExecutionAllowNetwork') === 'on' : undefined,
      egressAllowList,
      clearCodeExecutionOverrides: formData.get('clearCodeExecutionOverrides') === 'on',
    },
  };
}

export function applyCodeExecutionOverrides(
  current: AgentRuntimeConfig['codeExecution'] | undefined,
  input: Pick<
    CodeExecutionUpdateInput,
    'timeoutMs' | 'isolation' | 'allowNetwork' | 'egressAllowList' | 'clearCodeExecutionOverrides'
  >,
): AgentRuntimeConfig['codeExecution'] | undefined {
  if (input.clearCodeExecutionOverrides) {
    return undefined;
  }

  const codeExecution = { ...current };
  if (input.timeoutMs === null || input.timeoutMs === 0) {
    delete codeExecution.timeoutMs;
  } else if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    codeExecution.timeoutMs = input.timeoutMs;
  }
  if (input.isolation === null || input.isolation === '') {
    delete codeExecution.isolation;
  } else if (input.isolation && VALID_SANDBOX_ISOLATION.has(input.isolation as SandboxIsolation)) {
    codeExecution.isolation = input.isolation as SandboxIsolation;
  }
  if (input.allowNetwork === null) {
    delete codeExecution.allowNetwork;
  } else if (typeof input.allowNetwork === 'boolean') {
    codeExecution.allowNetwork = input.allowNetwork;
  }
  if (input.egressAllowList === null) {
    delete codeExecution.egressAllowList;
  } else if (Array.isArray(input.egressAllowList)) {
    codeExecution.egressAllowList = sanitizeEgressAllowList(input.egressAllowList);
  }

  return codeExecution.timeoutMs !== undefined ||
    codeExecution.isolation !== undefined ||
    codeExecution.allowNetwork !== undefined ||
    codeExecution.egressAllowList !== undefined
    ? codeExecution
    : undefined;
}

export function buildCodeExecutionActivityDetails(options: {
  runtimeType: AgentRuntimeType;
  codeExecutionEnabled: boolean;
  before: AgentRuntimeConfig['codeExecution'] | undefined;
  after: AgentRuntimeConfig['codeExecution'] | undefined;
  clearCodeExecutionOverrides?: boolean;
}): Record<string, unknown> {
  return {
    runtimeType: options.runtimeType,
    codeExecutionEnabled: options.codeExecutionEnabled,
    clearCodeExecutionOverrides: options.clearCodeExecutionOverrides === true,
    before: options.before ?? null,
    after: options.after ?? null,
    egressAllowList: options.after?.egressAllowList ?? null,
  };
}
