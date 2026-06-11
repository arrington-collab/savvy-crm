CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'overdue', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'ach', 'check', 'insurance', 'mortgage');--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DATA TYPE invoice_status USING status::invoice_status;--> statement-breakpoint
ALTER TABLE "invoice" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "payment" ALTER COLUMN "method" SET DATA TYPE payment_method USING method::payment_method;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_tenant_number_uniq" ON "invoice" USING btree ("tenant_id","number") WHERE number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_stripe_pmt_uniq" ON "payment" USING btree ("tenant_id","stripe_payment_id") WHERE stripe_payment_id IS NOT NULL;