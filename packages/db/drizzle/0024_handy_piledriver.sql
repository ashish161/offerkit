ALTER TABLE "loyalty_member" ADD COLUMN "card_code" text;--> statement-breakpoint
ALTER TABLE "loyalty_member" ADD CONSTRAINT "loyalty_member_card_code_unique" UNIQUE("card_code");