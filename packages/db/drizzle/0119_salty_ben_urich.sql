CREATE TABLE IF NOT EXISTS "daily_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exception_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"escalation_key" text NOT NULL,
	"rule_id" text NOT NULL,
	"event_id" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text NOT NULL,
	"notify" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"snooze_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exception_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exception_queue" ADD CONSTRAINT "exception_queue_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_date_uq" ON "daily_metrics" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exception_queue_key_uq" ON "exception_queue" USING btree ("tenant_id","escalation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exception_queue_state_idx" ON "exception_queue" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_metrics" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "exception_queue" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);