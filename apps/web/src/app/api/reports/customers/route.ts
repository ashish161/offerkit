import { db } from "@/lib/db";
import { getBrandCustomers } from "@/server/qr-loyalty/reports";
import { resolveReportScope } from "@/server/qr-loyalty/report-scope";

/**
 * GET /api/reports/customers?search=&limit= — customer-level list for the
 * brand's program (guard: same brand + PIN as /api/scan). Read-only.
 */
export async function GET(request: Request): Promise<Response> {
  const scope = await resolveReportScope(request);
  if (!scope.ok) return scope.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const customers = await getBrandCustomers(db(), scope.programId, { search, limit });
  return Response.json({ ok: true, customers });
}
