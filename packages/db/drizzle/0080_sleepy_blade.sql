CREATE TABLE IF NOT EXISTS "canvass_alert" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rep_id" uuid NOT NULL,
	"knock_id" uuid,
	"lead_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "canvass_alert" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "canvass_knock" ADD COLUMN "contract_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvass_knock" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_alert" ADD CONSTRAINT "canvass_alert_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_alert" ADD CONSTRAINT "canvass_alert_rep_id_canvass_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_alert" ADD CONSTRAINT "canvass_alert_knock_id_canvass_knock_id_fk" FOREIGN KEY ("knock_id") REFERENCES "public"."canvass_knock"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_alert_tenant_rep_idx" ON "canvass_alert" USING btree ("tenant_id","rep_id","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_alert_knock_idx" ON "canvass_alert" USING btree ("knock_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_alert" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);