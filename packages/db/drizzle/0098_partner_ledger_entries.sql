CREATE TABLE IF NOT EXISTS "partner_ledger_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"direction" text DEFAULT 'cost' NOT NULL,
	"amount_cents" integer NOT NULL,
	"source_ref" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_ledger_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_ledger_entry" ADD CONSTRAINT "partner_ledger_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_ledger_entry" ADD CONSTRAINT "partner_ledger_entry_partner_id_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "partner_ledger_entry" ADD CONSTRAINT "partner_ledger_entry_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_ledger_tenant_partner_idx" ON "partner_ledger_entry" USING btree ("tenant_id","partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "partner_ledger_tenant_kind_idx" ON "partner_ledger_entry" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "partner_ledger_source_ref_uq" ON "partner_ledger_entry" USING btree ("tenant_id","source_ref");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_ledger_entry" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);