CREATE TABLE IF NOT EXISTS "relationship_touch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"program" text NOT NULL,
	"channel" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"suppressed_reason" text,
	"template_version" text,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship_touch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "mail_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship_touch" ADD CONSTRAINT "relationship_touch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship_touch" ADD CONSTRAINT "relationship_touch_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_touch_tenant_customer_idx" ON "relationship_touch" USING btree ("tenant_id","customer_id","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_touch_tenant_program_idx" ON "relationship_touch" USING btree ("tenant_id","program");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relationship_touch" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);