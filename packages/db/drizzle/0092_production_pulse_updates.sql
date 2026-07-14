CREATE TABLE IF NOT EXISTS "crew_eod_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"crew_id" uuid,
	"day_key" text NOT NULL,
	"what_got_done" text NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tomorrow_plan" text,
	"source" text DEFAULT 'form' NOT NULL,
	"reported_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crew_eod_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_update" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"phase_key" text,
	"body" text,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"suppressed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_update" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "crew" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_eod_report" ADD CONSTRAINT "crew_eod_report_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_eod_report" ADD CONSTRAINT "crew_eod_report_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_eod_report" ADD CONSTRAINT "crew_eod_report_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_update" ADD CONSTRAINT "production_update_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_update" ADD CONSTRAINT "production_update_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_eod_job_day_uniq" ON "crew_eod_report" USING btree ("job_id","day_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crew_eod_tenant_day_idx" ON "crew_eod_report" USING btree ("tenant_id","day_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_update_tenant_job_idx" ON "production_update" USING btree ("tenant_id","job_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_update_tenant_sent_idx" ON "production_update" USING btree ("tenant_id","sent_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crew_eod_report" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "production_update" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);