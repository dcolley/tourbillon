CREATE TABLE "assistant_thread_pins" (
	"user_key" text NOT NULL,
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_thread_pins_user_key_thread_id_pk" PRIMARY KEY("user_key","thread_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_thread_pins" ADD CONSTRAINT "assistant_thread_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_thread_pins" ADD CONSTRAINT "assistant_thread_pins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_thread_pins_user_agent_idx" ON "assistant_thread_pins" USING btree ("user_key","company_id","agent_id");