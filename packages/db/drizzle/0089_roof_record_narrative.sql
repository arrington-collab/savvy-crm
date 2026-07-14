ALTER TABLE "inspection" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "narrative" text;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "narrative_drafted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "narrative_edited_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "inspection" ADD COLUMN "narrative_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inspection_zone" ADD COLUMN "summary" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inspection" ADD CONSTRAINT "inspection_narrative_edited_by_user_id_user_id_fk" FOREIGN KEY ("narrative_edited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
