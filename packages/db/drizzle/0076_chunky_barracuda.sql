ALTER TABLE "communication" ADD COLUMN "crew_id" uuid;--> statement-breakpoint
ALTER TABLE "communication" ADD COLUMN "language" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication" ADD CONSTRAINT "communication_crew_id_crew_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crew"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
