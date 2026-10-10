import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";

export interface BrandConfig {
  programId: string;
  pin: string;
}

export interface BrandContext {
  brand: string;
  programId: string;
  /** Present when the brand came from the database (not the legacy env map). */
  brandId?: string;
}

/** A brand row as stored in `qr_brand` (active, not soft-deleted). */
export interface DbBrand {
  id: string;
  name: string;
  programId: string;
  pinHash: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function parseBrands(env?: string): Readonly<Record<string, BrandConfig>> {
  if (!env || env.trim() === "") return {} as Record<string, BrandConfig>;

  let parsed: unknown;
  try {
    parsed = JSON.parse(env);
  } catch {
    return {} as Record<string, BrandConfig>;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {} as Record<string, BrandConfig>;
  }

  const out: Record<string, BrandConfig> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.trim() === "") continue;
    if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const pid = typeof v.programId === "string" ? v.programId.trim() : "";
    const pin = typeof v.pin === "string" ? v.pin : "";
    if (!isUuid(pid)) continue;
    if (pin === "") continue;
    out[key.trim()] = { programId: pid, pin };
  }
  return out;
}

export function brandFromHeader(request: Request): string | null {
  const h = request.headers.get("x-brand") ?? request.headers.get("X-Brand");
  if (!h) return null;
  const t = h.trim();
  return t === "" ? null : t;
}

/**
 * Brands configured in the database (active, not soft-deleted), ordered by
 * name. This is the primary source of truth for the multi-tenant QR flow;
 * `MULTI_TENANT_BRANDS` only applies when this returns an empty list.
 */
export async function loadBrands(database: Db): Promise<DbBrand[]> {
  return database
    .select({
      id: schema.qrBrand.id,
      name: schema.qrBrand.name,
      programId: schema.qrBrand.programId,
      pinHash: schema.qrBrand.pinHash,
    })
    .from(schema.qrBrand)
    .where(and(eq(schema.qrBrand.active, true), isNull(schema.qrBrand.deletedAt)))
    .orderBy(asc(schema.qrBrand.name));
}
