-- Reverses 0024_chat_tasks_task_runner.sql (TASK-RUNNER: the Run Task columns on chat_tasks).
-- Drizzle has no down migrations, so this is applied by hand when rolling back:
--   psql "$DATABASE_URL" -f packages/db/rollback/0024_chat_tasks_task_runner.down.sql
-- Dropping the columns forgets the task-runner bookkeeping (paused flag, attempt budget, last
-- Run Task run id). The chat task list itself (chat_tasks) survives — only these three
-- task-runner columns go. The journal row for 0024 in drizzle.__drizzle_migrations is removed
-- too. Run rollbacks newest first (see README.md in this folder).
ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "paused";
ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "runner_attempts";
ALTER TABLE "chat_tasks" DROP COLUMN IF EXISTS "runner_last_run_id";
