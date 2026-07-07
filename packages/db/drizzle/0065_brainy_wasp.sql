DROP INDEX IF EXISTS "claim_job_uniq";--> statement-breakpoint
ALTER TABLE "claim" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "line_items" jsonb;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN "parse_confidence" double precision;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim" ADD CONSTRAINT "claim_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim" ADD CONSTRAINT "claim_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_job_uniq" ON "claim" USING btree ("job_id") WHERE "claim"."job_id" is not null;
--> statement-breakpoint
UPDATE "claim" SET "lead_id" = "job"."lead_id", "property_id" = "job"."property_id"
  FROM "job" WHERE "claim"."job_id" = "job"."id" AND "claim"."lead_id" IS NULL;