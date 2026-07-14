CREATE TABLE IF NOT EXISTS "price_book_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_book_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tier_product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"product_name" text NOT NULL,
	"manufacturer" text NOT NULL,
	"unit_price_cents" integer,
	"unit_cost_cents" integer,
	"warranty_text" text DEFAULT '' NOT NULL,
	"warranty_registration" text,
	"recommended" boolean DEFAULT false NOT NULL,
	"color_palette" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tier_product" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX IF EXISTS "price_book_tenant_key_uniq";--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "price_book_version_id" uuid;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN "tiers" jsonb;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "qty_formula" text;--> statement-breakpoint
ALTER TABLE "price_book_item" ADD COLUMN "margin_floor_bps" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_version" ADD CONSTRAINT "price_book_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tier_product" ADD CONSTRAINT "tier_product_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_book_version_tenant_idx" ON "price_book_version" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_version_no_uniq" ON "price_book_version" USING btree ("tenant_id","version_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tier_product_tenant_idx" ON "tier_product" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tier_product_tenant_tier_uniq" ON "tier_product" USING btree ("tenant_id","tier");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_book_item" ADD CONSTRAINT "price_book_item_version_id_price_book_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."price_book_version"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_version_key_uniq" ON "price_book_item" USING btree ("version_id","key") WHERE version_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_book_tenant_key_uniq" ON "price_book_item" USING btree ("tenant_id","key") WHERE version_id is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "price_book_version" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tier_product" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);