CREATE TABLE IF NOT EXISTS "lead_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "roof_type_secondary" text;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "last_roof_replacement_at" date;--> statement-breakpoint
ALTER TABLE "property" ADD COLUMN "last_roof_replacement_source" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_note" ADD CONSTRAINT "lead_note_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_note" ADD CONSTRAINT "lead_note_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_note" ADD CONSTRAINT "lead_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_note_tenant_lead_idx" ON "lead_note" USING btree ("tenant_id","lead_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lead_note" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);