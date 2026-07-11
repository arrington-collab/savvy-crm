CREATE INDEX IF NOT EXISTS "agent_run_started_idx" ON "agent_run" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_job_idx" ON "agent_run" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_lead_idx" ON "agent_run" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_status_idx" ON "agent_run" USING btree ("status");