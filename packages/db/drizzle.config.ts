import { defineConfig } from 'drizzle-kit';
import { assertValidDatabaseUrl } from './src/database-url';

// Same check as the runtime client: a malformed URL fails with a fixed message, never the value.
assertValidDatabaseUrl(process.env.DATABASE_URL);

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
