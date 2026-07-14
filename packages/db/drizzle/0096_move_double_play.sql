CREATE TABLE IF NOT EXISTS "move_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"new_address" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "move_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warranty_transfer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"from_customer_id" uuid NOT NULL,
	"to_customer_id" uuid,
	"move_event_id" uuid,
	"baseline_inspection_id" uuid,
	"status" text DEFAULT 'offered' NOT NULL,
	"letter_status" text DEFAULT 'print_pending' NOT NULL,
	"registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warranty_transfer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "relationship_enrollment_job_idx";--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "moved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "new_address" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "move_event" ADD CONSTRAINT "move_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "move_event" ADD CONSTRAINT "move_event_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "move_event" ADD CONSTRAINT "move_event_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_transfer" ADD CONSTRAINT "warranty_transfer_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_transfer" ADD CONSTRAINT "warranty_transfer_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_transfer" ADD CONSTRAINT "warranty_transfer_from_customer_id_customer_id_fk" FOREIGN KEY ("from_customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_transfer" ADD CONSTRAINT "warranty_transfer_to_customer_id_customer_id_fk" FOREIGN KEY ("to_customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "warranty_transfer" ADD CONSTRAINT "warranty_transfer_move_event_id_move_event_id_fk" FOREIGN KEY ("move_event_id") REFERENCES "public"."move_event"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "move_event_tenant_status_idx" ON "move_event" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "move_event_tenant_customer_idx" ON "move_event" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warranty_transfer_tenant_property_idx" ON "warranty_transfer" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warranty_transfer_tenant_status_idx" ON "warranty_transfer" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relationship_enrollment_job_idx" ON "relationship_enrollment" USING btree ("tenant_id","job_id","customer_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "move_event" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "warranty_transfer" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);