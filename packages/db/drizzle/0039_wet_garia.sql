ALTER TABLE "job_task" RENAME TO "job_checklist_item";--> statement-breakpoint
ALTER TABLE "job_checklist_item" DROP CONSTRAINT "job_task_tenant_id_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "job_checklist_item" DROP CONSTRAINT "job_task_job_id_job_id_fk";
--> statement-breakpoint
ALTER TABLE "job_checklist_item" DROP CONSTRAINT "job_task_assignee_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "job_task_tenant_job_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_checklist_item" ADD CONSTRAINT "job_checklist_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_checklist_item" ADD CONSTRAINT "job_checklist_item_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_checklist_item" ADD CONSTRAINT "job_checklist_item_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_checklist_item_tenant_job_idx" ON "job_checklist_item" USING btree ("tenant_id","job_id");