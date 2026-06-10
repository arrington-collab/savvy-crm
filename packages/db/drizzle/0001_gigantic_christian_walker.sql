CREATE TABLE IF NOT EXISTS "job_stage_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"from_stage" "job_stage",
	"to_stage" "job_stage" NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_user_id" uuid,
	"by_agent" "agent",
	"note" text
);
--> statement-breakpoint
ALTER TABLE "job_stage_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_stage_event" ADD CONSTRAINT "job_stage_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_stage_event" ADD CONSTRAINT "job_stage_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_stage_event" ADD CONSTRAINT "job_stage_event_by_user_id_user_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_stage_event_tenant_job_idx" ON "job_stage_event" USING btree ("tenant_id","job_id","entered_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_stage_event" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);