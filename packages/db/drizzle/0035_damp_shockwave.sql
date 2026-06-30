CREATE TYPE "public"."integration_status" AS ENUM('pending', 'active', 'disabled', 'setup_requested');--> statement-breakpoint
CREATE TYPE "public"."telephony_mode" AS ENUM('platform', 'byo');--> statement-breakpoint
CREATE TYPE "public"."telephony_provider" AS ENUM('twilio', 'ringcentral', 'vapi');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "telephony_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "telephony_mode" "telephony_mode" DEFAULT 'platform' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connection_tenant_idx" ON "integration_connection" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connection_tenant_provider_uniq" ON "integration_connection" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration_connection" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);