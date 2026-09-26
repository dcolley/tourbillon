CREATE TABLE "vault_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"server_id" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"agent_id" text,
	"auth_type" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vault_secrets_unique_credential" UNIQUE("company_id","server_id","scope","user_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_secrets_company_idx" ON "vault_secrets" USING btree ("company_id");