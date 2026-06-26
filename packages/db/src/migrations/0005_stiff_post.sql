CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_mode" text DEFAULT 'chat' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;