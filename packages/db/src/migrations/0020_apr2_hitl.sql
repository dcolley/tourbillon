CREATE TABLE "hitl_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"item_ref" text,
	"at" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hitl_link_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"item_ref" text DEFAULT '' NOT NULL,
	"reviewer_kind" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "hitl_request" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "hitl_response" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "presented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hitl_events" ADD CONSTRAINT "hitl_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_events" ADD CONSTRAINT "hitl_events_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_link_tokens" ADD CONSTRAINT "hitl_link_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hitl_link_tokens" ADD CONSTRAINT "hitl_link_tokens_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hitl_events_approval_seq_uidx" ON "hitl_events" USING btree ("approval_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "hitl_link_tokens_binding_uidx" ON "hitl_link_tokens" USING btree ("approval_id","item_ref","reviewer_id");--> statement-breakpoint
CREATE INDEX "hitl_link_tokens_company_idx" ON "hitl_link_tokens" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_idempotency_uidx" ON "approvals" USING btree ("company_id","requested_by_agent_id","idempotency_key") WHERE "approvals"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "approvals_pending_deadline_idx" ON "approvals" USING btree ("deadline") WHERE "approvals"."status" = 'pending' and "approvals"."deadline" is not null;