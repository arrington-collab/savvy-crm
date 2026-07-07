ALTER TABLE "measurement" ADD COLUMN "source" text;--> statement-breakpoint
UPDATE "measurement" SET "source" = 'ordered' WHERE "provider" = 'roofr' AND "source" IS NULL;--> statement-breakpoint
UPDATE "measurement" SET "source" = 'sketch' WHERE "provider" = 'diy' AND "source" IS NULL;