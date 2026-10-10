CREATE TABLE "qr_brand" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"program_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qr_brand" ADD CONSTRAINT "qr_brand_program_id_loyalty_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."loyalty_program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qr_brand_active_name_unique" ON "qr_brand" USING btree (lower("name")) WHERE "qr_brand"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qr_brand_program_id_idx" ON "qr_brand" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "qr_brand_deleted_at_idx" ON "qr_brand" USING btree ("deleted_at");