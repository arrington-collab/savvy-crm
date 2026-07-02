ALTER TABLE "job_task" DROP CONSTRAINT "job_task_job_id_job_id_fk";
--> statement-breakpoint
ALTER TABLE "lead_task" DROP CONSTRAINT "lead_task_lead_id_lead_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_task" ADD CONSTRAINT "job_task_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
