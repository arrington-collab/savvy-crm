CREATE TABLE IF NOT EXISTS "contract_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"docuseal_template_id" text,
	"clauses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"effective_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estimate" ADD COLUMN IF NOT EXISTS "contract_template_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "contract_template_id" uuid;--> statement-breakpoint
-- canvass_rep.manager was added to the schema + applied to prod out-of-band
-- (commit 64a7ae1, migration `canvass_rep_manager_flag`) without updating the
-- drizzle journal, so drizzle-kit rediscovers it here. IF NOT EXISTS keeps this
-- migration safe to apply to prod (column already present) and fresh CI alike.
ALTER TABLE "canvass_rep" ADD COLUMN IF NOT EXISTS "manager" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contract_template" ADD CONSTRAINT "contract_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_template_tenant_state_version_idx" ON "contract_template" USING btree ("tenant_id","state","version");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "estimate" ADD CONSTRAINT "estimate_contract_template_id_contract_template_id_fk" FOREIGN KEY ("contract_template_id") REFERENCES "public"."contract_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document" ADD CONSTRAINT "document_contract_template_id_contract_template_id_fk" FOREIGN KEY ("contract_template_id") REFERENCES "public"."contract_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contract_template" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);