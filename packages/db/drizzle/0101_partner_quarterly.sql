CREATE TABLE IF NOT EXISTS "partner_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"quarter_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"report_code" text,
	"touch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "relationship_touch" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relationship_touch" ADD COLUMN "partner_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_report" ADD CONSTRAINT "partner_report_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_report" ADD CONSTRAINT "partner_report_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_report" ADD CONSTRAINT "partner_report_touch_id_relationship_touch_id_fk" FOREIGN KEY ("touch_id") REFERENCES "public"."relationship_touch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_report_tenant_quarter_idx" ON "partner_report" USING btree ("tenant_id","quarter_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_report_partner_quarter_uq" ON "partner_report" USING btree ("tenant_id","partner_id","quarter_key");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship_touch" ADD CONSTRAINT "relationship_touch_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_report" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
ALTER TABLE "relationship_touch" ADD CONSTRAINT "relationship_touch_subject_ck"
  CHECK (customer_id IS NOT NULL OR partner_id IS NOT NULL);
