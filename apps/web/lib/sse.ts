import IORedis from 'ioredis';

/** Per-process HTTP client callbacks — not the source of truth for events. */
const subscribers = new Map<string, Set<(data: string) => void>>();
const subscribedChannels = new Set<string>();

const redisSub = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

function channelFor(companyId: string): string {
  return `sse:${companyId}`;
}

function ensureRedisSubscription(companyId: string): void {
  const channel = channelFor(companyId);
  if (subscribedChannels.has(channel)) return;
  subscribedChannels.add(channel);
  void redisSub.subscribe(channel);
}

redisSub.on('message', (channel, message) => {
  if (!channel.startsWith('sse:')) return;
  const companyId = channel.slice('sse:'.length);
  const subs = subscribers.get(companyId);
  if (!subs || subs.size === 0) return;
  const payload = `data: ${message}\n\n`;
  subs.forEach((send) => send(payload));
});

export function getSseSubscribers(companyId: string): Set<(data: string) => void> {
  if (!subscribers.has(companyId)) subscribers.set(companyId, new Set());
  ensureRedisSubscription(companyId);
  return subscribers.get(companyId)!;
}

export function broadcastSSE(companyId: string, event: object): void {
  const subs = subscribers.get(companyId);
  if (!subs) return;
  const message = `data: ${JSON.stringify(event)}\n\n`;
  subs.forEach((send) => send(message));
}
