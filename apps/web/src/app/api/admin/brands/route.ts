import { db } from "@/lib/db";
import { parseBrands } from "@/server/qr-loyalty/brands";
import {
  brandCreateInput,
  createQrBrand,
  isUniqueViolation,
  listQrBrands,
  requireAdminSession,
} from "@/server/qr-loyalty/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/brands — every configured QR loyalty brand (admin only). */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireAdminSession(request);
  if (!guard.ok) return guard.response;

  const brands = await listQrBrands(db());
  const legacyEnvConfigured =
    Object.keys(parseBrands(process.env.MULTI_TENANT_BRANDS)).length > 0;
  return Response.json({ ok: true, brands, legacyEnvConfigured });
}

/** POST /api/admin/brands — create a brand with a program and PIN (admin only). */
export async function POST(request: Request): Promise<Response> {
  const guard = await requireAdminSession(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  const parsed = brandCreateInput.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        code: "validation_error",
        message: parsed.error.issues[0]?.message ?? "Invalid input",
      },
      { status: 400 },
    );
  }

  try {
    const brand = await createQrBrand(db(), parsed.data);
    return Response.json({ ok: true, brand }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json(
        { ok: false, code: "name_taken", message: "A brand with that name already exists" },
        { status: 409 },
      );
    }
    throw err;
  }
}
