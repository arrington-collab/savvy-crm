CREATE TABLE IF NOT EXISTS "municipal_inspection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"inspection_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recorded_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "municipal_inspection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_blocker" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"phase_key" text,
	"kind" text NOT NULL,
	"note" text,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reported_by_name" text,
	"status" text DEFAULT 'open' NOT NULL,
	"change_order_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_blocker" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_phase" ADD COLUMN "required_inspection_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "municipal_inspection" ADD CONSTRAINT "municipal_inspection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "municipal_inspection" ADD CONSTRAINT "municipal_inspection_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_blocker" ADD CONSTRAINT "production_blocker_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "production_blocker" ADD CONSTRAINT "production_blocker_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "municipal_inspection_job_key_uniq" ON "municipal_inspection" USING btree ("job_id","inspection_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_blocker_tenant_status_idx" ON "production_blocker" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "municipal_inspection" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "production_blocker" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);