ALTER TABLE "price_book_item" ADD COLUMN "unit_cost_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "material_order" ADD COLUMN "cost_subtotal_cents" integer DEFAULT 0 NOT NULL;