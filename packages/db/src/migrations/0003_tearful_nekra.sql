CREATE TABLE "agent_observability_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"heartbeat_run_id" text,
	"job_id" text,
	"agent_id" text,
	"issue_id" text,
	"project_id" text,
	"goal_id" text,
	"event_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"model" text,
	"tool_id" text,
	"input_preview" text,
	"output_preview" text,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"error_text" text,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "agent_observability_events" ADD CONSTRAINT "agent_observability_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_observability_events" ADD CONSTRAINT "agent_observability_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_observability_events_trace_span_uidx" ON "agent_observability_events" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_occurred_idx" ON "agent_observability_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_issue_occurred_idx" ON "agent_observability_events" USING btree ("company_id","issue_id","occurred_at") WHERE "agent_observability_events"."issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_project_occurred_idx" ON "agent_observability_events" USING btree ("company_id","project_id","occurred_at") WHERE "agent_observability_events"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_goal_occurred_idx" ON "agent_observability_events" USING btree ("company_id","goal_id","occurred_at") WHERE "agent_observability_events"."goal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_agent_occurred_idx" ON "agent_observability_events" USING btree ("company_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_observability_events_company_type_occurred_idx" ON "agent_observability_events" USING btree ("company_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_observability_events_trace_idx" ON "agent_observability_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "agent_observability_events_heartbeat_run_idx" ON "agent_observability_events" USING btree ("heartbeat_run_id") WHERE "agent_observability_events"."heartbeat_run_id" IS NOT NULL;