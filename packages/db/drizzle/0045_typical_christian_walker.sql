ALTER TABLE "document" ADD COLUMN "sitesnap_photo_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "capture_address" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "phash" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "qc_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "qc_reasons" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_tenant_sitesnap_uniq" ON "document" USING btree ("tenant_id","sitesnap_photo_id") WHERE "document"."sitesnap_photo_id" is not null;
