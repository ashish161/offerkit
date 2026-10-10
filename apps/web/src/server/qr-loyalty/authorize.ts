import { timingSafeEqual } from "node:crypto";
import type { BrandContext } from "./brands";
import { brandFromHeader, parseBrands } from "./brands";

/**
 * Guard for the public QR Loyalty merchant endpoints (/api/scan).
 *
 * - If MULTI_TENANT_BRANDS is unset/empty/invalid → legacy (no check), return null.
 * - Otherwise require brand + PIN via X-Brand and X-Brand-Pin headers.
 * - Return BrandContext on success, throw Response with 401 on failure.
 */
export async function authorizeScan(request: Request): Promise<BrandContext | null> {
  const brands = parseBrands(process.env.MULTI_TENANT_BRANDS);
  if (Object.keys(brands).length === 0) {
    return null; // legacy mode
  }

  const brand = brandFromHeader(request);
  if (!brand) {
    throw Response.json({ ok: false, code: "unknown_brand", message: "Brand required" }, { status: 401 });
  }

  const cfg = brands[brand];
  if (!cfg) {
    throw Response.json({ ok: false, code: "unknown_brand", message: "Unknown brand" }, { status: 401 });
  }

  const pinHeader = request.headers.get("x-brand-pin") ?? request.headers.get("X-Brand-Pin");
  if (!pinHeader) {
    throw Response.json({ ok: false, code: "invalid_pin", message: "Invalid PIN" }, { status: 401 });
  }

  const provided = pinHeader;
  const expected = cfg.pin;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Response.json({ ok: false, code: "invalid_pin", message: "Invalid PIN" }, { status: 401 });
  }

  return { brand, programId: cfg.programId };
}
