ALTER TABLE "user" ADD COLUMN "base_lat" double precision;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "base_lng" double precision;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "skills" text[] DEFAULT '{}' NOT NULL;