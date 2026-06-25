ALTER TABLE "customer" ADD COLUMN "sms_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "first_rep_contact_at" timestamp with time zone;