CREATE TABLE IF NOT EXISTS "canvass_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"metric" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_rep_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"winner_rep_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvass_challenge_participant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"rep_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"final_score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvass_challenge_participant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge" ADD CONSTRAINT "canvass_challenge_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge" ADD CONSTRAINT "canvass_challenge_created_by_rep_id_canvass_rep_id_fk" FOREIGN KEY ("created_by_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge" ADD CONSTRAINT "canvass_challenge_winner_rep_id_canvass_rep_id_fk" FOREIGN KEY ("winner_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge_participant" ADD CONSTRAINT "canvass_challenge_participant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge_participant" ADD CONSTRAINT "canvass_challenge_participant_challenge_id_canvass_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."canvass_challenge"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_challenge_participant" ADD CONSTRAINT "canvass_challenge_participant_rep_id_canvass_rep_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_challenge_tenant_idx" ON "canvass_challenge" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_challenge_tenant_status_idx" ON "canvass_challenge" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canvass_challenge_participant_uniq" ON "canvass_challenge_participant" USING btree ("challenge_id","rep_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_challenge_participant_tenant_idx" ON "canvass_challenge_participant" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_challenge" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "canvass_challenge_participant" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);