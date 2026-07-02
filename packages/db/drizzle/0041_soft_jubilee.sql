CREATE TABLE IF NOT EXISTS "lead_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"status" "job_task_status" DEFAULT 'pending' NOT NULL,
	"owner" text,
	"evidence" jsonb,
	"agent_run_id" uuid,
	"blocked_by" integer[] DEFAULT '{}' NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_task_lead_task_uniq" UNIQUE("lead_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "lead_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_task_tenant_lead_idx" ON "lead_task" USING btree ("tenant_id","lead_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lead_task" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);