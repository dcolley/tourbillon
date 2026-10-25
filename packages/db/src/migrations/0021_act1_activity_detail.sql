ALTER TABLE "activity_log" ADD COLUMN "correlation_id" text;--> statement-breakpoint
CREATE INDEX "activity_log_company_created_idx" ON "activity_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_company_entity_idx" ON "activity_log" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_log_company_correlation_idx" ON "activity_log" USING btree ("company_id","correlation_id") WHERE "activity_log"."correlation_id" is not null;