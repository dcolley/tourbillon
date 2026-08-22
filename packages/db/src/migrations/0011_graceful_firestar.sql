CREATE TABLE "agent_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"from_agent_id" text NOT NULL,
	"to_agent_id" text NOT NULL,
	"body" text NOT NULL,
	"in_reply_to" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "runtime_config" SET DEFAULT '{"heartbeat":{"enabled":false,"intervalSec":0,"scheduleMode":"interval","wakeOnAssignment":true,"wakeOnDemand":true},"timeout":{"heartbeatSec":300,"graceSec":30}}'::jsonb;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mail" ADD CONSTRAINT "agent_mail_in_reply_to_agent_mail_id_fk" FOREIGN KEY ("in_reply_to") REFERENCES "public"."agent_mail"("id") ON DELETE set null ON UPDATE no action;