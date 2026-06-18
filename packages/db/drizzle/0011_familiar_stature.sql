CREATE TABLE IF NOT EXISTS "crew_checkin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"crew_user_id" uuid NOT NULL,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_in_lat" double precision,
	"check_in_lng" double precision,
	"checked_out_at" timestamp with time zone,
	"check_out_lat" double precision,
	"check_out_lng" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crew_checkin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document" ALTER COLUMN "r2_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "companycam_connection_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "companycam_project_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "companycam_photo_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_checkin" ADD CONSTRAINT "crew_checkin_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_checkin" ADD CONSTRAINT "crew_checkin_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crew_checkin" ADD CONSTRAINT "crew_checkin_crew_user_id_user_id_fk" FOREIGN KEY ("crew_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crew_checkin_tenant_job_idx" ON "crew_checkin" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crew_checkin" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);