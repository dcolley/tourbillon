/**
 * S268-S4 (Refs #268): per-worktree/process key for egress proxy sockets
 * used by TESTS.
 *
 * `egressProxySocketPath(companyId, taskId)` is host-global: same inputs on
 * one machine always hash to the same `/…/<hash>.sock`. Parallel gate runs
 * (multiple worktrees, CI shards) that reuse a fixed test companyId thus
 * start on the SAME socket and each `stop()` unlinks the other's file - the
 * #268 gate saw `bwrap: Can't find source path /tmp/tourbillon-egress/…sock`
 * when three worktrees ran the egress tests concurrently.
 *
 * Test sockets therefore get a salt over the repo/worktree root AND the
 * process pid baked into the hashed identity before egressProxySocketPath
 * hashes it. Salted identity is hashed as usual, so the materialized path
 * stays a fixed-length `<hash>.sock` under the short socket root - never
 * longer than the un-salted path, always inside the AF_UNIX length limit.
 *
 * This is TEST-support scoping only; production per-run sockets already
 * carry a unique runId and are unaffected.
 */
import { createHash } from 'node:crypto';
import { egressProxySocketPath } from './egress-enforcement';

/** Short, stable salt: which worktree (repo root) and which process. */
export function egressTestSocketSalt(repoRoot: string = process.cwd(), pid: number = process.pid): string {
  const rootHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `wt${rootHash}p${pid}`;
}

/**
 * Like egressProxySocketPath, but the hashed identity additionally covers
 * the repo root and pid, so two concurrent worktrees (or CI shards sharing
 * one worktree) never map a fixed test companyId to the same socket file.
 * Deterministic within a process: the same (companyId, taskId, allowList)
 * in one process always yields the same path, so teardown unlinks its own.
 */
export function testEgressProxySocketPath(
  companyId: string,
  taskId?: string,
  allowList: string[] = [],
  options?: { socketRoot?: string; repoRoot?: string; pid?: number },
): string {
  const salt = egressTestSocketSalt(options?.repoRoot, options?.pid);
  return egressProxySocketPath(`${companyId}@${salt}`, taskId, allowList, {
    socketRoot: options?.socketRoot,
  });
}
