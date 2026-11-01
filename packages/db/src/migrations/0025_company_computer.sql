CREATE TABLE "company_computer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_url_key" text NOT NULL,
	"container_name" text NOT NULL,
	"image" text NOT NULL,
	"vnc_port" integer NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"takeover_status" text,
	"takeover_user_id" text,
	"takeover_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "company_computer_sessions_status_check" CHECK ("company_computer_sessions"."status" in ('starting', 'running', 'stopped', 'destroyed')),
	CONSTRAINT "company_computer_sessions_takeover_status_check" CHECK ("company_computer_sessions"."takeover_status" in ('watching', 'taken_over'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "has_computer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "has_computer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_computer_sessions" ADD CONSTRAINT "company_computer_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_computer_sessions" ADD CONSTRAINT "company_computer_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_computer_sessions_company_agent_status_idx" ON "company_computer_sessions" USING btree ("company_id","agent_id","status");