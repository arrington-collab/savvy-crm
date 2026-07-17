CREATE TABLE IF NOT EXISTS "neighborhood" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parcel_count" integer DEFAULT 0 NOT NULL,
	"our_completed_jobs" integer DEFAULT 0 NOT NULL,
	"turf_score" double precision DEFAULT 0 NOT NULL,
	"last_scored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "neighborhood" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "neighborhood" ADD CONSTRAINT "neighborhood_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "neighborhood_tenant_name_uq" ON "neighborhood" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "neighborhood" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);