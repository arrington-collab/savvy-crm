CREATE TABLE IF NOT EXISTS "inspection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid,
	"job_id" uuid,
	"property_id" uuid NOT NULL,
	"inspector_user_id" uuid,
	"kind" text DEFAULT 'initial' NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"baseline_inspection_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_checklist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"zone_kind" text DEFAULT 'other' NOT NULL,
	"name" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_checklist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_finding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_zone_id" uuid NOT NULL,
	"checklist_item_key" text,
	"severity_suggested" text,
	"what_it_is" text NOT NULL,
	"if_ignored" text,
	"timeframe" text,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disposition" text DEFAULT 'noted' NOT NULL,
	"repair_estimate_cents" integer,
	"created_by" text DEFAULT 'inspector' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"inspection_zone_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"checklist_item_key" text,
	"captured_at" timestamp with time zone,
	"gps_lat" text,
	"gps_lng" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inspection_zone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"zone_key" text NOT NULL,
	"zone_label" text NOT NULL,
	"zone_kind" text DEFAULT 'other' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"grade" text,
	"grade_set_by_user_id" uuid,
	"checklist_version_ref" text,
	"inspector_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection_zone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repair_credit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_inspection_id" uuid,
	"source_invoice_ref" text,
	"amount_cents" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"applied_estimate_id" uuid,
	"checkin_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repair_credit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "baseline_inspection_id" uuid;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "baseline_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_inspector_user_id_user_id_fk" FOREIGN KEY ("inspector_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_baseline_inspection_id_inspection_id_fk" FOREIGN KEY ("baseline_inspection_id") REFERENCES "public"."inspection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_checklist" ADD CONSTRAINT "inspection_checklist_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_finding" ADD CONSTRAINT "inspection_finding_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_finding" ADD CONSTRAINT "inspection_finding_inspection_zone_id_inspection_zone_id_fk" FOREIGN KEY ("inspection_zone_id") REFERENCES "public"."inspection_zone"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_inspection_id_inspection_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_media" ADD CONSTRAINT "inspection_media_inspection_zone_id_inspection_zone_id_fk" FOREIGN KEY ("inspection_zone_id") REFERENCES "public"."inspection_zone"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_zone" ADD CONSTRAINT "inspection_zone_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_zone" ADD CONSTRAINT "inspection_zone_inspection_id_inspection_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection_zone" ADD CONSTRAINT "inspection_zone_grade_set_by_user_id_user_id_fk" FOREIGN KEY ("grade_set_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repair_credit" ADD CONSTRAINT "repair_credit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repair_credit" ADD CONSTRAINT "repair_credit_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repair_credit" ADD CONSTRAINT "repair_credit_source_inspection_id_inspection_id_fk" FOREIGN KEY ("source_inspection_id") REFERENCES "public"."inspection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repair_credit" ADD CONSTRAINT "repair_credit_applied_estimate_id_estimate_id_fk" FOREIGN KEY ("applied_estimate_id") REFERENCES "public"."estimate"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_tenant_lead_idx" ON "inspection" USING btree ("tenant_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_tenant_property_idx" ON "inspection" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_tenant_status_idx" ON "inspection" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_checklist_key_version_uniq" ON "inspection_checklist" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_finding_tenant_zone_idx" ON "inspection_finding" USING btree ("tenant_id","inspection_zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_media_document_uniq" ON "inspection_media" USING btree ("inspection_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_media_tenant_zone_idx" ON "inspection_media" USING btree ("tenant_id","inspection_zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inspection_zone_key_uniq" ON "inspection_zone" USING btree ("inspection_id","zone_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inspection_zone_tenant_inspection_idx" ON "inspection_zone" USING btree ("tenant_id","inspection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repair_credit_tenant_customer_idx" ON "repair_credit" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repair_credit_tenant_status_idx" ON "repair_credit" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection_checklist" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection_finding" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection_media" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection_zone" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "repair_credit" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);