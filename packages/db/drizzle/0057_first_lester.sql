ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "financing_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "financing_ref" text;
