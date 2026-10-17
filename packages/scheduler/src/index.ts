/**
 * Scheduler entry. Kept tiny on purpose: DATABASE_URL is validated before anything that opens a
 * database client at import time is loaded, and that loading happens inside runSchedulerMain, so a
 * bad URL or an import-time failure becomes one sanitised log line and exit 1, never an uncaught
 * error that prints connection details.
 */
import { createTraceLogger } from '@tourbillon/shared';
import { assertValidDatabaseUrl } from '@tourbillon/db/database-url';
import { runSchedulerMain } from './startup';

const logger = createTraceLogger('scheduler', {});

void runSchedulerMain(async () => {
  assertValidDatabaseUrl(process.env.DATABASE_URL);
  const { main } = await import('./scheduler-main');
  await main(logger);
}, logger);
