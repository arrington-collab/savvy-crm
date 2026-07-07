ALTER TABLE "document" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "uploaded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "parse_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "parse_confidence" double precision;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document" ADD CONSTRAINT "document_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document" ADD CONSTRAINT "document_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_tenant_lead_idx" ON "document" USING btree ("tenant_id","lead_id");