CREATE TYPE "public"."claim_status" AS ENUM('filed', 'adjuster_scheduled', 'approved', 'partial', 'denied', 'closed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"claim_number" text,
	"carrier_name" text,
	"adjuster_name" text,
	"adjuster_phone" text,
	"status" "claim_status" DEFAULT 'filed' NOT NULL,
	"acv_cents" integer,
	"rcv_cents" integer,
	"deductible_cents" integer,
	"filed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim" ADD CONSTRAINT "claim_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim" ADD CONSTRAINT "claim_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_job_uniq" ON "claim" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_tenant_status_idx" ON "claim" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "claim" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);