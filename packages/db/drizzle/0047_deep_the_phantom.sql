CREATE TYPE "public"."supplier_invoice_status" AS ENUM('received', 'parsing', 'parsed', 'guarded', 'parse_failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"document_id" uuid,
	"supplier_name" text,
	"invoice_number" text,
	"invoice_date" timestamp with time zone,
	"total_cents" integer,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "supplier_invoice_status" DEFAULT 'received' NOT NULL,
	"parse_confidence" real,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice" ADD CONSTRAINT "supplier_invoice_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoice_tenant_job_idx" ON "supplier_invoice" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoice_tenant_msg_uniq" ON "supplier_invoice" USING btree ("tenant_id","external_message_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "supplier_invoice" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);