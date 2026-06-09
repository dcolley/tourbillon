import IORedis from 'ioredis';

export function createConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** @deprecated Use createConnection() — Queue and Worker need separate connections. */
export const connection = createConnection();
