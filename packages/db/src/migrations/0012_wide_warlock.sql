ALTER TABLE "agent_mail" DROP CONSTRAINT "agent_mail_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_mail" DROP CONSTRAINT "agent_mail_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_mail" DROP CONSTRAINT "agent_mail_in_reply_to_agent_mail_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "hitly_approval_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "hitly_error" text;