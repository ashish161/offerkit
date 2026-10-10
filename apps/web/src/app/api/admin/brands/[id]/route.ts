import { db } from "@/lib/db";
import {
  brandUpdateInput,
  deleteQrBrand,
  isUniqueViolation,
  requireAdminSession,
  updateQrBrand,
} from "@/server/qr-loyalty/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/admin/brands/[id] — rename, reassign the program, set/reset the
 * PIN, or activate/deactivate a brand (admin only).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await requireAdminSession(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return Response.json({ ok: false, code: "not_found", message: "Brand not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = brandUpdateInput.safeParse(body);
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
    const brand = await updateQrBrand(db(), id, parsed.data);
    if (!brand) {
      return Response.json({ ok: false, code: "not_found", message: "Brand not found" }, { status: 404 });
    }
    return Response.json({ ok: true, brand });
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

/** DELETE /api/admin/brands/[id] — soft-delete a brand (admin only). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await requireAdminSession(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return Response.json({ ok: false, code: "not_found", message: "Brand not found" }, { status: 404 });
  }

  const deleted = await deleteQrBrand(db(), id);
  if (!deleted) {
    return Response.json({ ok: false, code: "not_found", message: "Brand not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
