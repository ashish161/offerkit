import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import { auth } from "@/lib/auth";
import { hashPin } from "./pins";

// Admin-only management of DB-backed QR loyalty brands (qr_brand). Brands are
// created/reset by an admin in the dashboard; a brand itself only ever gets its
// own name + PIN and can read/scan its own program.

export const brandCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  programId: z.string().trim().uuid(),
  pin: z.string().trim().min(4).max(64),
});

export const brandUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    programId: z.string().trim().uuid().optional(),
    pin: z.string().trim().min(4).max(64).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export type BrandCreateInput = z.infer<typeof brandCreateInput>;
export type BrandUpdateInput = z.infer<typeof brandUpdateInput>;

export interface QrBrandRow {
  id: string;
  name: string;
  programId: string;
  active: boolean;
  campaignName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAuth {
  userId: string;
}

/** Session + role=admin guard for app-local admin routes. */
export async function requireAdminSession(
  request: Request,
): Promise<{ ok: true; auth: AdminAuth } | { ok: false; response: Response }> {
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, code: "unauthorized", message: "Sign in required" },
        { status: 401 },
      ),
    };
  }
  const role = (session.user as { role?: string }).role ?? "member";
  if (role !== "admin") {
    return {
      ok: false,
      response: Response.json(
        { ok: false, code: "forbidden", message: "Admin role required" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, auth: { userId: session.user.id } };
}

/** Postgres 23505 detector — Drizzle wraps the driver error on `.cause`. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      if ((current as { code?: unknown }).code === "23505") return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const brandSelection = {
  id: schema.qrBrand.id,
  name: schema.qrBrand.name,
  programId: schema.qrBrand.programId,
  active: schema.qrBrand.active,
  campaignName: schema.campaign.name,
  createdAt: schema.qrBrand.createdAt,
  updatedAt: schema.qrBrand.updatedAt,
} as const;

type RawBrandRow = {
  id: string;
  name: string;
  programId: string;
  active: boolean;
  campaignName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRow(row: RawBrandRow): QrBrandRow {
  return {
    id: row.id,
    name: row.name,
    programId: row.programId,
    active: row.active,
    campaignName: row.campaignName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** All active (non-deleted) brands with their program's campaign name. */
export async function listQrBrands(database: Db): Promise<QrBrandRow[]> {
  const rows = await database
    .select(brandSelection)
    .from(schema.qrBrand)
    .leftJoin(schema.loyaltyProgram, eq(schema.loyaltyProgram.id, schema.qrBrand.programId))
    .leftJoin(schema.campaign, eq(schema.campaign.id, schema.loyaltyProgram.campaignId))
    .where(isNull(schema.qrBrand.deletedAt))
    .orderBy(asc(schema.qrBrand.name));
  return rows.map(toRow);
}

async function getQrBrand(database: Db, id: string): Promise<QrBrandRow | null> {
  const [row] = await database
    .select(brandSelection)
    .from(schema.qrBrand)
    .leftJoin(schema.loyaltyProgram, eq(schema.loyaltyProgram.id, schema.qrBrand.programId))
    .leftJoin(schema.campaign, eq(schema.campaign.id, schema.loyaltyProgram.campaignId))
    .where(and(eq(schema.qrBrand.id, id), isNull(schema.qrBrand.deletedAt)))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function createQrBrand(
  database: Db,
  input: BrandCreateInput,
): Promise<QrBrandRow> {
  const pinHash = await hashPin(input.pin);
  const [inserted] = await database
    .insert(schema.qrBrand)
    .values({ name: input.name, programId: input.programId, pinHash })
    .returning({ id: schema.qrBrand.id });
  if (!inserted) throw new Error("brand insert failed");
  const row = await getQrBrand(database, inserted.id);
  if (!row) throw new Error("brand insert failed");
  return row;
}

export async function updateQrBrand(
  database: Db,
  id: string,
  input: BrandUpdateInput,
): Promise<QrBrandRow | null> {
  const patch: Partial<typeof schema.qrBrand.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.programId !== undefined) patch.programId = input.programId;
  if (input.active !== undefined) patch.active = input.active;
  if (input.pin !== undefined) patch.pinHash = await hashPin(input.pin);
  const [updated] = await database
    .update(schema.qrBrand)
    .set(patch)
    .where(and(eq(schema.qrBrand.id, id), isNull(schema.qrBrand.deletedAt)))
    .returning({ id: schema.qrBrand.id });
  if (!updated) return null;
  return getQrBrand(database, id);
}

/** Soft-delete a brand (keeps history; matches the repo's delete convention). */
export async function deleteQrBrand(database: Db, id: string): Promise<boolean> {
  const now = new Date();
  const [deleted] = await database
    .update(schema.qrBrand)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(schema.qrBrand.id, id), isNull(schema.qrBrand.deletedAt)))
    .returning({ id: schema.qrBrand.id });
  return Boolean(deleted);
}
