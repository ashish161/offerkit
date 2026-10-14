import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { loyaltyProgram } from "./loyalty.ts";

// A brand is a named terminal identity for the multi-tenant QR loyalty flow:
// one loyalty program plus a PIN that guards /scan and /reports for that
// program. Managed by admins in the dashboard; replaces the legacy
// MULTI_TENANT_BRANDS env map. PINs are stored hashed (better-auth/crypto).
export const qrBrand = pgTable(
  "qr_brand",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    programId: uuid("program_id")
      .notNull()
      .references(() => loyaltyProgram.id, { onDelete: "cascade" }),
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Brand names are case-insensitive and unique among non-deleted rows.
    uniqueIndex("qr_brand_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index("qr_brand_program_id_idx").on(t.programId),
    index("qr_brand_deleted_at_idx").on(t.deletedAt),
  ],
);
