CREATE TABLE IF NOT EXISTS "membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"annual_price_cents" integer NOT NULL,
	"checkout_session_id" text,
	"stripe_subscription_id" text,
	"started_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership" ADD CONSTRAINT "membership_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_tenant_idx" ON "membership" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_tenant_customer_idx" ON "membership" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_live_uq" ON "membership" USING btree ("tenant_id","customer_id") WHERE status in ('draft','pending','active','past_due');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);