CREATE TABLE IF NOT EXISTS "crew_gap" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"gap_start" text NOT NULL,
	"gap_end" text NOT NULL,
	"free_minutes" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"pass_reason" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crew_gap" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fill_play" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gap_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"discount_bps" integer,
	"original_total_cents" integer,
	"discounted_total_cents" integer,
	"status" text DEFAULT 'proposed' NOT NULL,
	"suppressed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "fill_play" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_gap" ADD CONSTRAINT "crew_gap_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_gap" ADD CONSTRAINT "crew_gap_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fill_play" ADD CONSTRAINT "fill_play_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fill_play" ADD CONSTRAINT "fill_play_gap_id_crew_gap_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."crew_gap"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fill_play" ADD CONSTRAINT "fill_play_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crew_gap_tenant_idx" ON "crew_gap" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "crew_gap_open_uq" ON "crew_gap" USING btree ("tenant_id","crew_id","gap_start") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fill_play_tenant_idx" ON "fill_play" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fill_play_gap_idx" ON "fill_play" USING btree ("gap_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fill_play_target_uq" ON "fill_play" USING btree ("tenant_id","gap_id","kind","target_ref");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crew_gap" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fill_play" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);