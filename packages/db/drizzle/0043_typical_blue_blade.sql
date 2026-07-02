CREATE TABLE IF NOT EXISTS "tenant_ops_rollup" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_auto_green" integer DEFAULT 0 NOT NULL,
	"total_tasks" integer DEFAULT 0 NOT NULL,
	"green_count" integer DEFAULT 0 NOT NULL,
	"amber_count" integer DEFAULT 0 NOT NULL,
	"red_count" integer DEFAULT 0 NOT NULL,
	"open_exception_count" integer DEFAULT 0 NOT NULL,
	"jobs_30d" integer DEFAULT 0 NOT NULL,
	"founder_minutes_30d" numeric DEFAULT '0' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_ops_rollup_tenant_uniq" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_ops_rollup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_ops_rollup" ADD CONSTRAINT "tenant_ops_rollup_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_ops_rollup" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);