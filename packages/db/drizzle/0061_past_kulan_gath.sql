ALTER TABLE "appointment" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "property_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointment" ADD CONSTRAINT "appointment_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointment" ADD CONSTRAINT "appointment_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill lead/property scope onto existing (job-scoped) appointments.
UPDATE "appointment" a
SET "property_id" = j."property_id",
    "lead_id" = COALESCE(a."lead_id", j."lead_id")
FROM "job" j
WHERE a."job_id" = j."id" AND a."property_id" IS NULL;
