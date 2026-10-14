import { db } from "@/lib/db";
import { getBrandReport } from "@/server/qr-loyalty/reports";
import { resolveReportScope } from "@/server/qr-loyalty/report-scope";

/**
 * GET /api/reports — read-only per-brand loyalty report (brand aggregate).
 * Guarded by the same brand + PIN gate as /api/scan.
 */
export async function GET(request: Request): Promise<Response> {
  const scope = await resolveReportScope(request);
  if (!scope.ok) return scope.response;

  const report = await getBrandReport(db(), scope.programId);
  return Response.json({ ok: true, report });
}
