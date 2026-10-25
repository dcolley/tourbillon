CREATE TABLE "assistant_active_threads" (
	"company_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_active_threads_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_active_threads" ADD CONSTRAINT "assistant_active_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_active_threads" ADD CONSTRAINT "assistant_active_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;