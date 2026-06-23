ALTER TABLE "lead" ADD COLUMN "score_features" jsonb;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "install_recommendation" jsonb;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "line1" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "county" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "roof_type" text;