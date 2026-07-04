ALTER TABLE "communication" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "booking_link" ADD COLUMN "kind" text DEFAULT 'booking' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_dedupe_uniq" ON "communication" USING btree ("tenant_id","dedupe_key") WHERE dedupe_key is not null;