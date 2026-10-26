-- Reverses 0023_chat_tasks.sql (TASK-1: the Assistant's private per-agent chat task list).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0023_chat_tasks.down.sql
-- Dropping the table forgets every agent's private chat to-do list (chat_tasks); company issues
-- are untouched — this list was never part of the control plane. The table's foreign keys,
-- primary key, status CHECK and (company_id, agent_id, status) index go with the table. The
-- journal row for 0023 in drizzle.__drizzle_migrations is removed too. Run rollbacks newest
-- first (see README.md in this folder): roll back any later migration before this file, or
-- `pnpm db:migrate` will skip 0023.
DROP TABLE IF EXISTS "chat_tasks";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793021932250;
