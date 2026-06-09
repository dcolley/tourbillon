import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

const connectionString = process.env.DATABASE_URL!;
const poolMax = parseInt(process.env.DATABASE_POOL_MAX ?? '5', 10);

type PostgresClient = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as {
  postgresClient?: PostgresClient;
};

function createClient(): PostgresClient {
  return postgres(connectionString, {
    prepare: false,
    max: poolMax,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });
}

// Reuse one pool per process. Next.js dev HMR otherwise leaks connections on reload.
const client = globalForDb.postgresClient ?? createClient();
if (process.env.NODE_ENV !== 'production') {
  globalForDb.postgresClient = client;
}

export const db = drizzle(client, { schema });
export type DbClient = typeof db;
