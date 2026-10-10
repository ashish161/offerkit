import { db } from "@/lib/db";
import { getBrandCustomerReport } from "@/server/qr-loyalty/reports";
import { resolveReportScope } from "@/server/qr-loyalty/report-scope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/reports/customer?memberId= — full customer-level report (profile,
 * points, ledger, scans) for one membership in the brand's program. The member
 * must belong to the PIN's program, so a brand can never read another brand's
 * customer. Read-only.
 */
export async function GET(request: Request): Promise<Response> {
  const scope = await resolveReportScope(request);
  if (!scope.ok) return scope.response;

  const memberId = new URL(request.url).searchParams.get("memberId")?.trim();
  if (!memberId || !UUID_RE.test(memberId)) {
    return Response.json(
      { ok: false, code: "validation_error", message: "memberId must be a UUID" },
      { status: 400 },
    );
  }

  const report = await getBrandCustomerReport(db(), scope.programId, memberId);
  if (!report) {
    return Response.json(
      { ok: false, code: "member_not_found", message: "Customer is not in this brand" },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, report });
}
