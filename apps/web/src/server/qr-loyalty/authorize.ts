import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { BrandContext } from "./brands";
import { brandFromHeader, loadBrands, parseBrands } from "./brands";
import { verifyPin } from "./pins";

/**
 * Guard for the public QR Loyalty merchant + report endpoints.
 *
 * - If the deployment has brands (`qr_brand` rows, or legacy
 *   `MULTI_TENANT_BRANDS` when the table is empty) → require a brand + PIN via
 *   the `X-Brand` / `X-Brand-Pin` headers.
 * - Otherwise → legacy single-brand mode (no check), return null.
 *
 * DB brands take precedence: `MULTI_TENANT_BRANDS` only applies when the
 * `qr_brand` table has no active rows. Return BrandContext on success, throw a
 * Response with 401 on failure.
 */
export async function authorizeScan(request: Request): Promise<BrandContext | null> {
  const dbBrands = await loadBrands(db());
  if (dbBrands.length > 0) {
    const brand = brandFromHeader(request);
    if (!brand) {
      throw Response.json(
        { ok: false, code: "unknown_brand", message: "Brand required" },
        { status: 401 },
      );
    }
    const cfg = dbBrands.find((b) => b.name.toLowerCase() === brand.toLowerCase());
    if (!cfg) {
      throw Response.json(
        { ok: false, code: "unknown_brand", message: "Unknown brand" },
        { status: 401 },
      );
    }
    const pinHeader = readPinHeader(request);
    if (!pinHeader || !(await verifyPin(pinHeader, cfg.pinHash))) {
      throw Response.json(
        { ok: false, code: "invalid_pin", message: "Invalid PIN" },
        { status: 401 },
      );
    }
    return { brand: cfg.name, programId: cfg.programId, brandId: cfg.id };
  }

  // Legacy env fallback (also the path used by tests that toggle the env var).
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

  const pinHeader = readPinHeader(request);
  if (!pinHeader) {
    throw Response.json({ ok: false, code: "invalid_pin", message: "Invalid PIN" }, { status: 401 });
  }

  const a = Buffer.from(pinHeader);
  const b = Buffer.from(cfg.pin);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Response.json({ ok: false, code: "invalid_pin", message: "Invalid PIN" }, { status: 401 });
  }

  return { brand, programId: cfg.programId };
}

function readPinHeader(request: Request): string | null {
  return request.headers.get("x-brand-pin") ?? request.headers.get("X-Brand-Pin");
}
