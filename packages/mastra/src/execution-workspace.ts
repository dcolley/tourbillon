import {
  Workspace,
  LocalSandbox,
  getRecommendedIsolation,
  type IsolationBackend,
} from '@mastra/core/workspace';
import { ensureExecutionWorkspace } from '@tourbillon/shared';

const VALID_ISOLATION = new Set<IsolationBackend>(['none', 'seatbelt', 'bwrap']);

function resolveIsolation(): IsolationBackend {
  const raw = process.env.SANDBOX_ISOLATION?.trim().toLowerCase();
  if (raw && VALID_ISOLATION.has(raw as IsolationBackend)) {
    return raw as IsolationBackend;
  }
  return getRecommendedIsolation();
}

function resolveTimeout(): number {
  const raw = process.env.SANDBOX_COMMAND_TIMEOUT_MS?.trim();
  const parsed = raw ? parseInt(raw, 10) : 120_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

export function buildCodeExecutionWorkspace(): Workspace {
  return new Workspace({
    id: 'tourbillon-code-execution',
    name: 'Code execution',
    sandbox: async ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      if (!companyId) {
        throw new Error('companyId not present in request context for code execution sandbox');
      }
      const taskId = requestContext.get('taskId') as string | undefined;
      const cwd = await ensureExecutionWorkspace(companyId, taskId);
      return new LocalSandbox({
        workingDirectory: cwd,
        isolation: resolveIsolation(),
        timeout: resolveTimeout(),
      });
    },
    sandboxCacheKey: ({ requestContext }) => {
      const companyId = requestContext.get('companyId') as string | undefined;
      const taskId = requestContext.get('taskId') as string | undefined;
      return companyId ? `${companyId}:${taskId ?? 'idle'}` : undefined;
    },
  });
}
