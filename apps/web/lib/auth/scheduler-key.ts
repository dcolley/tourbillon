export function validateSchedulerKey(token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = process.env.SCHEDULER_API_KEY;
  if (!expected) return false;
  return token === expected;
}
