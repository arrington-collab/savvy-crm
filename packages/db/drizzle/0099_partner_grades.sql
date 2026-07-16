ALTER TABLE "partner" ADD COLUMN "grade" text;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "graded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "scheduling_priority" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "slack_capacity_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "c_card_status" text;--> statement-breakpoint
ALTER TABLE "partner" ADD COLUMN "c_card_resolution" text;