CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'done', 'canceled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."appointment_type" AS ENUM('inspection', 'cm', 'crew');--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "type" SET DATA TYPE appointment_type USING type::appointment_type;--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "ends_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "status" SET DATA TYPE appointment_status USING status::appointment_status;--> statement-breakpoint
ALTER TABLE "appointment" ALTER COLUMN "status" SET DEFAULT 'scheduled';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "gcal_connection_id" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist (
    assignee_user_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled');
