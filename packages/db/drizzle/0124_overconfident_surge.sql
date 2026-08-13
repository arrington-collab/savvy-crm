ALTER TABLE "canvass_sold_listing" ADD COLUMN "status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ADD COLUMN "status_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ADD COLUMN "status_by_rep_id" uuid;--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ADD COLUMN "assigned_rep_id" uuid;--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canvass_sold_listing" ADD COLUMN "route_seq" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_sold_listing" ADD CONSTRAINT "canvass_sold_listing_status_by_rep_id_canvass_rep_id_fk" FOREIGN KEY ("status_by_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "canvass_sold_listing" ADD CONSTRAINT "canvass_sold_listing_assigned_rep_id_canvass_rep_id_fk" FOREIGN KEY ("assigned_rep_id") REFERENCES "public"."canvass_rep"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_sold_tenant_assigned_idx" ON "canvass_sold_listing" USING btree ("tenant_id","assigned_rep_id","route_seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvass_sold_tenant_status_idx" ON "canvass_sold_listing" USING btree ("tenant_id","status","status_at");