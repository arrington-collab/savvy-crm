CREATE TABLE IF NOT EXISTS "orchestrator_escalation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text NOT NULL,
	"notify" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestrator_escalation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orchestrator_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor" text,
	"agent" text NOT NULL,
	"outcome" text NOT NULL,
	"emitted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestrator_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orchestrator_escalation" ADD CONSTRAINT "orchestrator_escalation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orchestrator_event" ADD CONSTRAINT "orchestrator_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orchestrator_escalation_open_idx" ON "orchestrator_escalation" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orchestrator_event_corr_idx" ON "orchestrator_event" USING btree ("tenant_id","correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orchestrator_event_idem_uq" ON "orchestrator_event" USING btree ("tenant_id","idempotency_key") WHERE outcome = 'received';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orchestrator_escalation" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orchestrator_event" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);