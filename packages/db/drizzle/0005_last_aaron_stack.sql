CREATE TYPE "public"."commission_model" AS ENUM('flat', 'profit', 'tiered');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('pending', 'approved', 'paid');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"model" "commission_model" NOT NULL,
	"basis_cents" integer NOT NULL,
	"rate" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"period_key" text NOT NULL,
	"status" "commission_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "qbo_connection_id" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "qbo_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "qbo_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission" ADD CONSTRAINT "commission_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission" ADD CONSTRAINT "commission_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commission" ADD CONSTRAINT "commission_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_tenant_user_idx" ON "commission" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_tenant_invoice_uniq" ON "commission" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commission" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);