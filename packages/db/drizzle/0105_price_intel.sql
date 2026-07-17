CREATE TABLE IF NOT EXISTS "competitor" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "competitor_bid_cents" integer;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "competitor_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor" ADD CONSTRAINT "competitor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_tenant_idx" ON "competitor" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competitor_tenant_key_uq" ON "competitor" USING btree ("tenant_id","normalized_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "competitor" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);