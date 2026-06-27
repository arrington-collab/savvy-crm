ALTER TABLE "lead" ADD COLUMN "voice_call_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_voice_call_id_idx" ON "lead" USING btree ("tenant_id","voice_call_id");