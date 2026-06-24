CREATE TYPE "public"."storm_cert_status" AS ENUM('pending', 'verified', 'none', 'error');--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "storm_cert_status" "storm_cert_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "storm_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "storm_cert_document_id" uuid;