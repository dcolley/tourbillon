const subscribers = new Map<string, Set<(data: string) => void>>();

export function getSseSubscribers(companyId: string): Set<(data: string) => void> {
  if (!subscribers.has(companyId)) subscribers.set(companyId, new Set());
  return subscribers.get(companyId)!;
}

export function broadcastSSE(companyId: string, event: object): void {
  const subs = subscribers.get(companyId);
  if (!subs) return;
  const message = `data: ${JSON.stringify(event)}\n\n`;
  subs.forEach((send) => send(message));
}
