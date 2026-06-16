CREATE TABLE IF NOT EXISTS "usage_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"ai_spend_cents" integer DEFAULT 0 NOT NULL,
	"ai_voice_minutes" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"band_key" text NOT NULL,
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"overage_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communication" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_snapshot" ADD CONSTRAINT "usage_snapshot_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_snapshot_tenant_idx" ON "usage_snapshot" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_snapshot_tenant_period_uniq" ON "usage_snapshot" USING btree ("tenant_id","period_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_snapshot" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);