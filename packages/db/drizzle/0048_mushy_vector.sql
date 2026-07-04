CREATE TYPE "public"."credit_request_status" AS ENUM('drafted', 'sent', 'credited', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"job_id" uuid,
	"supplier_name" text,
	"claimed_cents" integer DEFAULT 0 NOT NULL,
	"status" "credit_request_status" DEFAULT 'drafted' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"recovered_cents" integer DEFAULT 0 NOT NULL,
	"email_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_request" ADD CONSTRAINT "credit_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_request" ADD CONSTRAINT "credit_request_supplier_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoice"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_request" ADD CONSTRAINT "credit_request_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_request_tenant_supplier_idx" ON "credit_request" USING btree ("tenant_id","supplier_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_request_tenant_status_idx" ON "credit_request" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_request" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);