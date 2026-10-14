import { resolveDefaultQrProgram } from "@offerkit/core/loyalty";
import { db } from "@/lib/db";
import { authorizeScan } from "./authorize";

export type ReportScope = { ok: true; programId: string } | { ok: false; response: Response };

/**
 * Resolve the loyalty program a report request may read.
 *
 * Reuses the same brand + PIN gate as /api/scan (via `authorizeScan`), so a
 * brand can only ever read its own program. Legacy mode (no
 * MULTI_TENANT_BRANDS) falls back to the newest loyalty program, matching the
 * rest of the POC.
 */
export async function resolveReportScope(request: Request): Promise<ReportScope> {
  let programId: string;
  try {
    const ctx = await authorizeScan(request);
    programId = ctx?.programId ?? ((await resolveDefaultQrProgram(db())) ?? "");
  } catch (err) {
    if (err instanceof Response) return { ok: false, response: err };
    throw err;
  }

  if (!programId) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, code: "no_program", message: "No loyalty program configured" },
        { status: 404 },
      ),
    };
  }
  return { ok: true, programId };
}
