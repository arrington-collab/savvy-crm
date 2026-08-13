CREATE TABLE IF NOT EXISTS "canvass_sold_listing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mls" text,
	"address" text NOT NULL,
	"city" text,
	"state" text,
	"zip" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"sold_date" date NOT NULL,
	"price" integer,
	"property_type" text,
	"beds" integer,
	"baths" numeric,
	"sqft" integer,
	"year_built" integer,
	"url" text,
	"source" text DEFAULT 'redfin_recently_sold' NOT NULL,
	"dedupe_key" text NOT NULL,
	"expires_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_sold_listing" ADD CONSTRAINT "canvass_sold_listing_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvass_sold_tenant_source_dedupe_uniq" ON "canvass_sold_listing" USING btree ("tenant_id","source","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_sold_tenant_lat_lng_idx" ON "canvass_sold_listing" USING btree ("tenant_id","lat","lng");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_sold_tenant_source_expires_idx" ON "canvass_sold_listing" USING btree ("tenant_id","source","expires_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_sold_listing" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);