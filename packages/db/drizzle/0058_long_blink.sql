ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "lender_name" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "endorsement_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "endorsement_last_action_at" timestamp with time zone;
