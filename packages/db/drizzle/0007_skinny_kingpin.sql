CREATE TYPE "public"."price_book_category" AS ENUM('material', 'labor', 'accessory', 'upgrade');--> statement-breakpoint
CREATE TYPE "public"."price_book_unit" AS ENUM('square', 'lf', 'each', 'flat');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_book_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "price_book_category" NOT NULL,
	"unit" "price_book_unit" NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"source_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waste_applies" boolean DEFAULT false NOT NULL,
	"pack_size" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_book_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "measurement_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "waste_pct_used" integer;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "pitch_tier_applied" text;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "upsell_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "docuseal_submission_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item" ADD CONSTRAINT "price_book_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_book_tenant_idx" ON "price_book_item" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_tenant_key_uniq" ON "price_book_item" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_book_item" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);