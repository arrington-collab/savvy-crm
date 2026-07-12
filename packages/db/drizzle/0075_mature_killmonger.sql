CREATE TABLE IF NOT EXISTS "canvass_achievement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rep_id" uuid NOT NULL,
	"badge_key" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_achievement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_achievement" ADD CONSTRAINT "canvass_achievement_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_achievement" ADD CONSTRAINT "canvass_achievement_rep_id_canvass_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvass_achievement_uniq" ON "canvass_achievement" USING btree ("tenant_id","rep_id","badge_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_achievement_tenant_idx" ON "canvass_achievement" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_achievement" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);