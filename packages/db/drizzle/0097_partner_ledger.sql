CREATE TABLE IF NOT EXISTS "partner" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"org" text,
	"class" text DEFAULT 'other' NOT NULL,
	"phone" text,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"normalized_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "partner_merge_candidate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_a_id" uuid NOT NULL,
	"partner_b_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_merge_candidate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "partner_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner" ADD CONSTRAINT "partner_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_merge_candidate" ADD CONSTRAINT "partner_merge_candidate_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_merge_candidate" ADD CONSTRAINT "partner_merge_candidate_partner_a_id_partner_id_fk" FOREIGN KEY ("partner_a_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_merge_candidate" ADD CONSTRAINT "partner_merge_candidate_partner_b_id_partner_id_fk" FOREIGN KEY ("partner_b_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_tenant_idx" ON "partner" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_tenant_key_uq" ON "partner" USING btree ("tenant_id","normalized_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_merge_tenant_status_idx" ON "partner_merge_candidate" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_merge_pair_uq" ON "partner_merge_candidate" USING btree ("tenant_id","partner_a_id","partner_b_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead" ADD CONSTRAINT "lead_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_merge_candidate" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);