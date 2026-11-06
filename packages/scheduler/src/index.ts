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
  const { main, installSchedulerProcessGuards } = await import('./scheduler-main');
  // #338: installed at the ENTRY, not inside main() — main() is called per-boot in production
  // exactly once, while unit tests call it repeatedly and must keep Node's default rejection
  // semantics for their own assertions.
  installSchedulerProcessGuards(logger);
  await main(logger);
}, logger);
