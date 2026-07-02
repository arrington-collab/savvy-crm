CREATE TYPE "public"."evidence_status" AS ENUM('pass', 'fail', 'stale', 'skip');--> statement-breakpoint
CREATE TYPE "public"."job_task_status" AS ENUM('pending', 'in_progress', 'done', 'verified', 'exception', 'failed', 'skipped', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."task_health_status" AS ENUM('green', 'amber', 'red', 'gray');--> statement-breakpoint
CREATE TYPE "public"."task_mode" AS ENUM('full_auto', 'assisted', 'manual');--> statement-breakpoint
CREATE TYPE "public"."task_owner" AS ENUM('SAGE', 'ATLAS', 'NOVA', 'MILO', 'VERA', 'SCOUT', 'HUMAN');--> statement-breakpoint
CREATE TYPE "public"."task_scope" AS ENUM('per_job', 'per_lead', 'per_tenant_recurring', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."verification_tier" AS ENUM('execution', 'invariant', 'reconciliation', 'sampled_audit');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"status" "job_task_status" DEFAULT 'pending' NOT NULL,
	"owner" text,
	"evidence" jsonb,
	"agent_run_id" uuid,
	"blocked_by" integer[] DEFAULT '{}' NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_task_job_task_uniq" UNIQUE("job_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "job_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_health" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"status" "task_health_status" DEFAULT 'gray' NOT NULL,
	"effective_mode" "task_mode" NOT NULL,
	"clean_streak_days" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"fail_count_7d" integer DEFAULT 0 NOT NULL,
	"open_exception_count" integer DEFAULT 0 NOT NULL,
	"founder_minutes_30d" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_health_uniq" UNIQUE("tenant_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "task_health" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_registry" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"phase" integer NOT NULL,
	"default_owner" "task_owner" NOT NULL,
	"default_mode" "task_mode" NOT NULL,
	"scope" "task_scope" NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"depends_on" integer[] DEFAULT '{}' NOT NULL,
	"check_key" text,
	"check_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification_tier" "verification_tier",
	"sla_hours" integer,
	"est_founder_minutes" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_registry_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_task_config" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"mode" "task_mode",
	"enabled" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_task_config_uniq" UNIQUE("tenant_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_task_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" integer NOT NULL,
	"check_key" text NOT NULL,
	"status" "evidence_status" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "timezone" text DEFAULT 'America/Phoenix' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "digest_times" jsonb DEFAULT '["07:00","17:00"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "break_glass" jsonb DEFAULT '{"min_dollars":10000,"deadline_hours":48}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_task" ADD CONSTRAINT "job_task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_task" ADD CONSTRAINT "job_task_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_task" ADD CONSTRAINT "job_task_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_task" ADD CONSTRAINT "job_task_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_health" ADD CONSTRAINT "task_health_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_health" ADD CONSTRAINT "task_health_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_task_config" ADD CONSTRAINT "tenant_task_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_task_config" ADD CONSTRAINT "tenant_task_config_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_task_id_task_registry_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_registry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_task_tenant_job_idx" ON "job_task" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_health_tenant_idx" ON "task_health" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_registry_phase_idx" ON "task_registry" USING btree ("phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_task_config_tenant_idx" ON "tenant_task_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_run_tenant_task_idx" ON "verification_run" USING btree ("tenant_id","task_id","ran_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_task" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "task_health" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_task_config" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "verification_run" AS PERMISSIVE FOR ALL TO "savvy_app" USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);