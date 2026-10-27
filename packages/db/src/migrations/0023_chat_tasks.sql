CREATE TABLE "chat_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"requested_by_user_id" text,
	"requested_by_display_name" text,
	"source_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "chat_tasks_status_check" CHECK ("chat_tasks"."status" in ('pending', 'in_progress', 'waiting_on_user', 'done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "chat_tasks" ADD CONSTRAINT "chat_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_tasks" ADD CONSTRAINT "chat_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_tasks_company_agent_status_idx" ON "chat_tasks" USING btree ("company_id","agent_id","status");