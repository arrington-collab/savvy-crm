CREATE TABLE IF NOT EXISTS "referral_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"payee_name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "source_detail" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_payment" ADD CONSTRAINT "referral_payment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_payment" ADD CONSTRAINT "referral_payment_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_payment" ADD CONSTRAINT "referral_payment_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_payment_tenant_job_uniq" ON "referral_payment" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "referral_payment" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Slice 3: map every legacy lead.source to the structured enum (zero orphans).
UPDATE "lead" SET source = 'web'            WHERE source IN ('web','website','seed','e2e','test') OR source IS NULL;
UPDATE "lead" SET source = 'canvass'        WHERE source IN ('door-knocking','door_knock','storm_canvass');
UPDATE "lead" SET source = 'inbound_call'   WHERE source = 'inbound-call';
UPDATE "lead" SET source = 'inbound_call', source_detail = '{"note":"after-hours voicemail"}'::jsonb WHERE source = 'after-hours-voicemail';
UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"google_ads"}'::jsonb WHERE source = 'google';
UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"meta"}'::jsonb       WHERE source = 'facebook';
UPDATE "lead" SET source = 'insurance_agent' WHERE source = 'carrier';
UPDATE "lead" SET source = 'other', source_detail = '{"note":"yard sign"}'::jsonb      WHERE source = 'yard_sign';
UPDATE "lead" SET source = 'other', source_detail = '{"note":"repeat customer"}'::jsonb WHERE source = 'repeat';
-- referral, other, and the machine set (canvass/inbound_call/direct_mail) already match; leave as-is.
-- Catch-all: any remaining unknown value → other with the original label preserved.
UPDATE "lead" SET source_detail = jsonb_build_object('custom_label', source), source = 'other'
  WHERE source <> ALL (ARRAY['referral','insurance_agent','ads','realtor','partner','other','web','inbound_call','canvass','direct_mail']);