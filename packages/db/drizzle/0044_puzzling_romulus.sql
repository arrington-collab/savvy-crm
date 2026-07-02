CREATE TABLE IF NOT EXISTS "task_exception" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"dollar_impact_cents" integer DEFAULT 0 NOT NULL,
	"break_glass" boolean DEFAULT false NOT NULL,
	"break_glass_notified_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_viewed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_exception" ADD CONSTRAINT "task_exception_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_exception" ADD CONSTRAINT "task_exception_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_exception_tenant_idx" ON "task_exception" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_exception_open_uniq" ON "task_exception" USING btree ("tenant_id","task_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "task_exception" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);