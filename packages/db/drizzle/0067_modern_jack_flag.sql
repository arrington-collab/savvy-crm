ALTER TABLE "estimate" ADD COLUMN "measurement_source" text;
--> statement-breakpoint
UPDATE "estimate" SET "measurement_source" = "measurement"."source"
  FROM "measurement" WHERE "estimate"."measurement_id" = "measurement"."id" AND "estimate"."measurement_source" IS NULL;