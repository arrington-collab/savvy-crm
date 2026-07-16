CREATE TABLE IF NOT EXISTS "mail_campaign" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"trigger_ref" text,
	"job_id" uuid,
	"audience_count" integer DEFAULT 0 NOT NULL,
	"est_cost_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_campaign" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_piece" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"property_id" uuid,
	"address_text" text NOT NULL,
	"type" text DEFAULT 'postcard' NOT NULL,
	"wave" integer DEFAULT 1 NOT NULL,
	"template_key" text NOT NULL,
	"merge_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mail_by_date" timestamp with time zone NOT NULL,
	"arrive_window_start" timestamp with time zone NOT NULL,
	"arrive_window_end" timestamp with time zone NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'print_pending' NOT NULL,
	"postgrid_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_piece" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_campaign_id_mail_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."mail_campaign"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_campaign_tenant_kind_idx" ON "mail_campaign" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_campaign_kind_trigger_uq" ON "mail_campaign" USING btree ("tenant_id","kind","trigger_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_piece_tenant_campaign_idx" ON "mail_piece" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_piece_tenant_status_idx" ON "mail_piece" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_piece_campaign_target_wave_uq" ON "mail_piece" USING btree ("tenant_id","campaign_id","property_id","wave");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mail_campaign" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mail_piece" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);