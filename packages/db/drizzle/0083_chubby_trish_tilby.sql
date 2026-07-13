ALTER TABLE "job" ADD COLUMN "requested_install_week" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "signing_url" text;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "deposit_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "deposit_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "deposit_paid_at" timestamp with time zone;