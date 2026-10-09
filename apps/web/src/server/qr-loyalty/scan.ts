import { z } from "zod";
import { scanEarn } from "@offerkit/core/loyalty";
import { db } from "@/lib/db";
import { authorizeScan } from "./authorize";

const scanInput = z
  .object({
    cardCode: z
      .string()
      .trim()
      .min(4)
      .max(32)
      .regex(/^[A-Za-z0-9-]+$/, "card code must be alphanumeric")
      .optional(),
    phone: z
      .string()
      .trim()
      .min(6)
      .max(32)
      .regex(/^[0-9+\-() ]+$/, "phone must contain only digits and + - ( ) spaces")
      .optional(),
    /** Bill amount as a decimal string or number in major units (e.g. 2500 = ₹2,500). */
    amount: z.coerce.number().positive().max(1_000_000_000),
    eventId: z.string().trim().min(8).max(128).optional(),
  })
  .refine((v) => Boolean(v.cardCode) || Boolean(v.phone), {
    message: "cardCode or phone is required",
  });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * POST /api/scan — merchant scan endpoint for the QR Loyalty POC.
 *
 * Public (no session) by design; guarded by authorizeScan() so a real
 * auth check can be dropped in later without touching call sites.
 * All business logic lives in @offerkit/core — this is a thin adapter.
 */
export async function handleScan(request: Request): Promise<Response> {
  await authorizeScan(request);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "validation_error", message: "Invalid JSON body" }, 400);
  }

  const parsed = scanInput.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(
      { ok: false, code: "validation_error", message: first?.message ?? "Invalid input" },
      400,
    );
  }

  // Major units → minor units (paise), matching LoyaltyEarnFormula semantics.
  const amountMinor = Math.round(parsed.data.amount * 100);
  const result = await scanEarn(db(), {
    cardCode: parsed.data.cardCode,
    phone: parsed.data.phone,
    amountMinor,
    eventId: parsed.data.eventId,
    note: `QR scan · bill ${String(parsed.data.amount)}`,
  });

  if (!result.ok) {
    const status = result.code === "member_not_found" ? 404 : 422;
    return json(result, status);
  }
  return json(result);
}
