import { closeAgentBrowser, destroyCodeExecutionWorkspace } from '@tourbillon/mastra';

type WakeAgentLike = {
  getWorkspace?: (options?: unknown) => Promise<unknown>;
  browser?: unknown;
};

export interface WakeTeardownDeps {
  destroyWorkspace?: (workspace: unknown) => Promise<void>;
  closeBrowser?: (...agents: Array<WakeAgentLike | undefined>) => Promise<void>;
}

/**
 * Release everything a wake attached to its Agent / DurableAgent, on every exit path
 * (success, failure, abort, wall-clock timeout):
 *
 * - the code-execution workspace (its egress-proxy unix socket stays on disk unless
 *   the sandbox is destroyed), and
 * - the `browser` toolset's Chromium.
 *
 * Each step is best-effort and independent: a failing workspace teardown never skips
 * the browser close, and nothing here masks the original wake error.
 */
export async function releaseWakeResources(
  agents: WakeAgentLike | undefined | Array<WakeAgentLike | undefined>,
  deps: WakeTeardownDeps = {},
): Promise<void> {
  const list = Array.isArray(agents) ? agents : [agents];
  const destroyWorkspace =
    deps.destroyWorkspace ?? ((workspace: unknown) => destroyCodeExecutionWorkspace(workspace as never));
  for (const agent of list) {
    try {
      const workspace = await agent?.getWorkspace?.();
      if (workspace) await destroyWorkspace(workspace);
    } catch {
      /* teardown is best-effort; never mask the original wake error */
    }
  }
  try {
    await (deps.closeBrowser ?? closeAgentBrowser)(...list);
  } catch {
    /* best-effort */
  }
}
