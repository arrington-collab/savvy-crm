CREATE TABLE IF NOT EXISTS "daily_metrics_by_location" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"location_id" uuid,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_metrics_by_location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_metrics_by_rep" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"location_id" uuid,
	"rep_id" uuid NOT NULL,
	"leads" integer NOT NULL,
	"first_touches" integer NOT NULL,
	"median_speed_seconds" integer,
	"appts_set" integer NOT NULL,
	"no_shows" integer NOT NULL,
	"contracts" integer NOT NULL,
	"contract_value_cents" bigint NOT NULL,
	"estimates_approved" integer NOT NULL,
	"avg_margin_pct" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_metrics_by_rep" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_metrics_by_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"location_id" uuid,
	"source" text NOT NULL,
	"leads" integer NOT NULL,
	"appts_set" integer NOT NULL,
	"contracts" integer NOT NULL,
	"contract_value_cents" bigint NOT NULL,
	"cost_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_metrics_by_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scorecard_goal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid,
	"metric_key" text NOT NULL,
	"target" real NOT NULL,
	"direction" text NOT NULL,
	"is_placeholder" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scorecard_goal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weekly_scorecard" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_start" text NOT NULL,
	"location_id" uuid,
	"metric_key" text NOT NULL,
	"value" jsonb,
	"goal" jsonb,
	"on_track" boolean,
	"prior_weeks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weekly_scorecard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_metrics_by_location" ADD CONSTRAINT "daily_metrics_by_location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_metrics_by_rep" ADD CONSTRAINT "daily_metrics_by_rep_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_metrics_by_source" ADD CONSTRAINT "daily_metrics_by_source_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scorecard_goal" ADD CONSTRAINT "scorecard_goal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weekly_scorecard" ADD CONSTRAINT "weekly_scorecard_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_by_location_uq" ON "daily_metrics_by_location" USING btree ("tenant_id","business_date","location_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_by_rep_uq" ON "daily_metrics_by_rep" USING btree ("tenant_id","business_date","location_id","rep_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_by_source_uq" ON "daily_metrics_by_source" USING btree ("tenant_id","business_date","location_id","source") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scorecard_goal_uq" ON "scorecard_goal" USING btree ("tenant_id","location_id","metric_key") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "weekly_scorecard_uq" ON "weekly_scorecard" USING btree ("tenant_id","week_start","location_id","metric_key") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_metrics_by_location" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_metrics_by_rep" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_metrics_by_source" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "scorecard_goal" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "weekly_scorecard" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);