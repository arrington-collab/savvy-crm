CREATE TABLE IF NOT EXISTS "valuation_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"status" text NOT NULL,
	"reasons" jsonb,
	"sde_cents" integer,
	"value_low_cents" integer,
	"value_likely_cents" integer,
	"value_high_cents" integer,
	"multiple_low" double precision,
	"multiple_high" double precision,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_quality" jsonb,
	"inputs" jsonb,
	"methodology_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "valuation_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "valuation_snapshot" ADD CONSTRAINT "valuation_snapshot_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "valuation_snapshot_tenant_idx" ON "valuation_snapshot" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "valuation_snapshot_period_uq" ON "valuation_snapshot" USING btree ("tenant_id","period_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "valuation_snapshot" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);