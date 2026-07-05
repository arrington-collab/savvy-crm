CREATE TABLE IF NOT EXISTS "canvass_knock" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rep_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"outcome" text NOT NULL,
	"address" text,
	"contact_name" text,
	"contact_phone" text,
	"notes" text,
	"amount" double precision,
	"scheduled_at" timestamp with time zone,
	"territory_id" uuid,
	"gps_flagged" boolean DEFAULT false NOT NULL,
	"gps_distance_m" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_knock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvass_territory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"points" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_territory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_knock" ADD CONSTRAINT "canvass_knock_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_knock" ADD CONSTRAINT "canvass_knock_rep_id_canvass_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_territory" ADD CONSTRAINT "canvass_territory_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_knock_tenant_idx" ON "canvass_knock" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_knock_tenant_rep_idx" ON "canvass_knock" USING btree ("tenant_id","rep_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvass_knock_client_uniq" ON "canvass_knock" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_territory_tenant_idx" ON "canvass_territory" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_knock" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_territory" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);