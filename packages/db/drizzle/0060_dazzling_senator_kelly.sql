ALTER TABLE "estimate" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "property_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "estimate_tenant_lead_idx" ON "estimate" USING btree ("tenant_id","lead_id");--> statement-breakpoint
-- Backfill lead/property scope onto existing (job-scoped) estimates. property_id is
-- NOT NULL on job; lead_id is nullable there, so only copy it when the job carries one.
UPDATE "estimate" e
SET "property_id" = j."property_id",
    "lead_id" = COALESCE(e."lead_id", j."lead_id")
FROM "job" j
WHERE e."job_id" = j."id" AND e."property_id" IS NULL;