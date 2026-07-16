CREATE TABLE IF NOT EXISTS "boost_card" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"copy" text NOT NULL,
	"photo_document_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boost_card" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "marketing_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvass_territory" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "canvass_territory" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "canvass_territory" ADD COLUMN "active_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvass_territory" ADD COLUMN "active_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvass_territory" ADD COLUMN "context" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boost_card" ADD CONSTRAINT "boost_card_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boost_card" ADD CONSTRAINT "boost_card_campaign_id_mail_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."mail_campaign"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boost_card" ADD CONSTRAINT "boost_card_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boost_card" ADD CONSTRAINT "boost_card_photo_document_id_document_id_fk" FOREIGN KEY ("photo_document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "boost_card" ADD CONSTRAINT "boost_card_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boost_card_tenant_status_idx" ON "boost_card" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "boost_card_campaign_kind_uq" ON "boost_card" USING btree ("tenant_id","campaign_id","kind");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "boost_card" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);