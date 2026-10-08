/**
 * Scheduler bearer key check for internal web routes (e.g. routine issue create).
 *
 * The configured SCHEDULER_API_KEY is validated here at first use, not at import, so `next build`
 * works with it unset. When it is unset, padded with whitespace, a placeholder, has a character outside
 * printable ASCII or is too short, every presented key is
 * refused and the reason (never the value) is logged once per reason per process.
 */
import {
  checkSchedulerApiKey,
  describeSchedulerApiKeyProblem,
  type SchedulerApiKeyProblem,
} from '@tourbillon/shared/scheduler-key';

const loggedProblems = new Set<SchedulerApiKeyProblem>();

function logConfigProblemOnce(problem: SchedulerApiKeyProblem): void {
  if (loggedProblems.has(problem)) return;
  loggedProblems.add(problem);
  console.error(`[scheduler-key] ${describeSchedulerApiKeyProblem(problem)}; scheduler-key requests are refused`);
}

/** Test hook: forget which config problems were already logged. */
export function resetSchedulerKeyLogStateForTests(): void {
  loggedProblems.clear();
}

export function validateSchedulerKey(token: string | null | undefined): boolean {
  if (!token) return false;
  const result = checkSchedulerApiKey(token);
  if (result.ok) return true;
  if (result.reason === 'config') logConfigProblemOnce(result.problem);
  return false;
}
