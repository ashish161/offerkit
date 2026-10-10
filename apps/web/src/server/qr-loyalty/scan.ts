import { z } from "zod";
import { scanEarn, getMemberByCardCode, getMemberByPhone, resolveDefaultQrProgram } from "@offerkit/core/loyalty";
import { db } from "@/lib/db";
import { authorizeScan } from "./authorize";
import type { BrandContext } from "./brands";

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
    /** Unique bill/invoice number from the POS — the idempotency key. */
    billNumber: z.string().trim().min(1).max(128),
    /** Quick-enroll: customer name used when `phone` is not a member yet. */
    name: z.string().trim().min(1).max(200).optional(),
    /** Quick-enroll: customer email used when `phone` is not a member yet. */
    email: z.string().trim().email().max(320).optional(),
    /** Quick-enroll: loyalty program to enroll into (defaults to the newest active one). */
    programId: z.string().trim().uuid().optional(),
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
  let ctx: BrandContext | null = null;
  try {
    ctx = await authorizeScan(request);
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }

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

  // Wrong-brand gate in brand mode: if a member exists for the provided card/phone,
  // reject if they belong to a different program than the terminal's brand.
  if (ctx) {
    const identifier = parsed.data.cardCode ? { type: "card" as const, v: parsed.data.cardCode } : parsed.data.phone ? { type: "phone" as const, v: parsed.data.phone } : null;
    if (identifier) {
      let member: { programId: string } | null = null;
      if (identifier.type === "card") {
        member = await getMemberByCardCode(db(), identifier.v);
      } else if (identifier.type === "phone") {
        member = await getMemberByPhone(db(), identifier.v);
      }
      if (member && member.programId !== ctx.programId) {
        return json({ ok: false, code: "wrong_brand", message: "Wrong brand for this card/phone" }, 403);
      }
    }
  }

  // Major units → minor units (paise), matching LoyaltyEarnFormula semantics.
  const amountMinor = Math.round(parsed.data.amount * 100);

  // A `name` alongside a phone opts into quick-enroll when the phone is new.
  let quickEnroll: { name: string; programId: string; email?: string } | undefined;
  if (parsed.data.name && parsed.data.phone) {
    const programId = ctx ? ctx.programId : parsed.data.programId ?? (await resolveDefaultQrProgram(db()));
    if (!programId) {
      return json(
        { ok: false, code: "validation_error", message: "No loyalty program configured for enroll" },
        400,
      );
    }
    quickEnroll = {
      name: parsed.data.name,
      programId,
      ...(parsed.data.email?.trim() ? { email: parsed.data.email.trim() } : {}),
    };
  }

  const result = await scanEarn(db(), {
    cardCode: parsed.data.cardCode,
    phone: parsed.data.phone,
    amountMinor,
    billNumber: parsed.data.billNumber,
    quickEnroll,
  });

  if (!result.ok) {
    const status =
      result.code === "member_not_found"
        ? 404
        : result.code === "bill_already_processed"
          ? 409
          : 422;
    return json(result, status);
  }
  // A replay of an already-processed bill is not a new credit — surface it as a
  // conflict so the merchant doesn't believe points were awarded again.
  if (result.alreadyCredited) {
    return json(result, 409);
  }
  return json(result);
}
