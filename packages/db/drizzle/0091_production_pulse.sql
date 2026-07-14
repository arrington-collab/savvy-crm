CREATE TABLE IF NOT EXISTS "production_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"production_phase_id" uuid,
	"phase_key_raw" text,
	"document_id" uuid NOT NULL,
	"shot" text,
	"crew_id" uuid,
	"crew_member_name" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_phase" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"phase_key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"customer_visible" boolean DEFAULT true NOT NULL,
	"expected_duration_hours" double precision DEFAULT 2 NOT NULL,
	"template_version_ref" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"evidence_photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_phase" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_phase_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_phase_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crew_checkin" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_media" ADD CONSTRAINT "production_media_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_media" ADD CONSTRAINT "production_media_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_media" ADD CONSTRAINT "production_media_production_phase_id_production_phase_id_fk" FOREIGN KEY ("production_phase_id") REFERENCES "public"."production_phase"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_media" ADD CONSTRAINT "production_media_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_phase" ADD CONSTRAINT "production_phase_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_phase" ADD CONSTRAINT "production_phase_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_phase_template" ADD CONSTRAINT "production_phase_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_media_document_uniq" ON "production_media" USING btree ("job_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_media_tenant_phase_idx" ON "production_media" USING btree ("tenant_id","production_phase_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_phase_job_key_uniq" ON "production_phase" USING btree ("job_id","phase_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_phase_tenant_job_idx" ON "production_phase" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_phase_tenant_status_idx" ON "production_phase" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_phase_template_uniq" ON "production_phase_template" USING btree ("tenant_id","job_type","version");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "production_media" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "production_phase" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "production_phase_template" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);