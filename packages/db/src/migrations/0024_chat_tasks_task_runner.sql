ALTER TABLE "chat_tasks" ADD COLUMN IF NOT EXISTS "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_tasks" ADD COLUMN IF NOT EXISTS "runner_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_tasks" ADD COLUMN IF NOT EXISTS "runner_last_run_id" text;
