CREATE TABLE "company_llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_llm_providers" ADD CONSTRAINT "company_llm_providers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_llm_providers" ADD CONSTRAINT "company_llm_providers_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_llm_providers_company_provider_uidx" ON "company_llm_providers" USING btree ("company_id","provider_id");