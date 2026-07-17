CREATE TABLE IF NOT EXISTS "material_leftover" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"name" text,
	"quantity" double precision NOT NULL,
	"unit" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"document_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_leftover" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "material_reconciliation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"leftovers_confirmed_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_reconciliation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "material_return" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"name" text,
	"quantity" double precision NOT NULL,
	"expected_credit_cents" integer DEFAULT 0 NOT NULL,
	"recovered_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_pickup' NOT NULL,
	"credit_request_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_return" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "returnable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "restocking_fee_pct" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_leftover" ADD CONSTRAINT "material_leftover_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_leftover" ADD CONSTRAINT "material_leftover_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_leftover" ADD CONSTRAINT "material_leftover_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_leftover" ADD CONSTRAINT "material_leftover_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_reconciliation" ADD CONSTRAINT "material_reconciliation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_reconciliation" ADD CONSTRAINT "material_reconciliation_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_return" ADD CONSTRAINT "material_return_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_return" ADD CONSTRAINT "material_return_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_return" ADD CONSTRAINT "material_return_credit_request_id_credit_request_id_fk" FOREIGN KEY ("credit_request_id") REFERENCES "public"."credit_request"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_leftover_tenant_job_idx" ON "material_leftover" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_leftover_job_item_uq" ON "material_leftover" USING btree ("tenant_id","job_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_reconciliation_job_uq" ON "material_reconciliation" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_return_tenant_status_idx" ON "material_return" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_return_job_item_uq" ON "material_return" USING btree ("tenant_id","job_id","item_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "material_leftover" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "material_reconciliation" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "material_return" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
UPDATE "price_book_item" SET "returnable" = true
 WHERE "key" IN ('field-shingles','starter-strip','hip-ridge-cap','drip-edge','underlayment','ice-water-shield','valley-metal','step-flashing','pipe-boots');
