CREATE TABLE IF NOT EXISTS "contact_suppression" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid,
	"contact_id" uuid,
	"phone_e164" text,
	"email" text,
	"channel" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_suppression" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_suppression" ADD CONSTRAINT "contact_suppression_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_suppression_phone_uq" ON "contact_suppression" USING btree ("tenant_id","phone_e164","channel") WHERE phone_e164 is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_suppression_email_uq" ON "contact_suppression" USING btree ("tenant_id","email","channel") WHERE email is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_suppression_contact_idx" ON "contact_suppression" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_suppression" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);