CREATE TABLE IF NOT EXISTS "spotter_pin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"material_tag" text,
	"has_debris" boolean DEFAULT false NOT NULL,
	"spotter_name" text,
	"tagged_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"matched_property_id" uuid,
	"precision_score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spotter_pin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spotter_pin" ADD CONSTRAINT "spotter_pin_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spotter_pin" ADD CONSTRAINT "spotter_pin_matched_property_id_property_id_fk" FOREIGN KEY ("matched_property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spotter_pin_tenant_external_uq" ON "spotter_pin" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spotter_pin_tenant_property_idx" ON "spotter_pin" USING btree ("tenant_id","matched_property_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "spotter_pin" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);