-- Reverses 0022_assistant_active_threads.sql (ASYNC-0 Slice B: the agent's active Assistant thread).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0022_assistant_active_threads.down.sql
-- Dropping the table forgets which thread is each agent's active Assistant conversation; threads
-- themselves are untouched (the Assistant then falls back to the agent's latest thread by activity).
-- The table's foreign keys and primary key go with it. The journal row for 0022 in
-- drizzle.__drizzle_migrations is removed too. Run rollbacks newest first (see README.md in this
-- folder): roll back any later migration before this file, or `pnpm db:migrate` will skip 0022.
DROP TABLE IF EXISTS "assistant_active_threads";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792939255828;
