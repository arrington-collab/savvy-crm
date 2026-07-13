CREATE TABLE IF NOT EXISTS "canvass_spiff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"challenge_id" uuid,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"winner_rep_id" uuid NOT NULL,
	"from_rep_id" uuid,
	"status" text DEFAULT 'owed' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "canvass_spiff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_spiff" ADD CONSTRAINT "canvass_spiff_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_spiff" ADD CONSTRAINT "canvass_spiff_challenge_id_canvass_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."canvass_challenge"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_spiff" ADD CONSTRAINT "canvass_spiff_winner_rep_id_canvass_rep_id_fk" FOREIGN KEY ("winner_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_spiff" ADD CONSTRAINT "canvass_spiff_from_rep_id_canvass_rep_id_fk" FOREIGN KEY ("from_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_spiff_tenant_idx" ON "canvass_spiff" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_spiff_winner_idx" ON "canvass_spiff" USING btree ("winner_rep_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_spiff" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);