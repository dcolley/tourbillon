-- Reverses 0019_assistant_thread_pins.sql (UI-2: per-user assistant thread pins).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0019_assistant_thread_pins.down.sql
-- Dropping the table removes every thread pin; threads themselves are untouched. The table's
-- foreign keys and primary key go with it. The journal row for 0019 in
-- drizzle.__drizzle_migrations is removed too, so a later `pnpm db:migrate` re-applies it cleanly.
DROP INDEX IF EXISTS "assistant_thread_pins_user_agent_idx";
DROP TABLE IF EXISTS "assistant_thread_pins";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792776456879;
