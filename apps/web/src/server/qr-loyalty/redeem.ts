import { z } from "zod";
import {
  getMemberByCardCode,
  getMemberByPhone,
  redeemReward,
  resolveDefaultQrProgram,
} from "@offerkit/core/loyalty";
import { db } from "@/lib/db";
import { authorizeScan } from "./authorize";
import type { BrandContext } from "./brands";
import { findBrandMemberByPhone } from "./scan";
import { listProgramRewards } from "./rewards";

const redeemInput = z
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
    rewardId: z.string().trim().uuid(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.cardCode) || Boolean(v.phone), {
    message: "cardCode or phone is required",
  });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * GET /api/rewards — the rewards a terminal can redeem, for the PCI/POS to
 * render a picker. Public (no session); guarded by the same brand + PIN as
 * /api/scan. In brand mode only that brand's program is returned; legacy mode
 * falls back to the newest loyalty program.
 */
export async function handleListRewards(request: Request): Promise<Response> {
  let ctx: BrandContext | null = null;
  try {
    ctx = await authorizeScan(request);
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }

  const database = db();
  const programId = ctx ? ctx.programId : await resolveDefaultQrProgram(database);
  if (!programId) return json({ ok: true, programId: null, rewards: [] });

  return json({ ok: true, programId, rewards: await listProgramRewards(database, programId) });
}

/**
 * POST /api/redeem — merchant terminal redemption for the QR Loyalty POC.
 *
 * Public (no session) by design; guarded by authorizeScan() (brand + PIN in
 * brand mode). Resolves the member *within the terminal's brand*, then defers
 * to the engine's redeemReward(), which checks the balance, writes the REDEEM
 * ledger row and returns the reward payload. Fulfillment is manual: the POS
 * applies the payload and hands the reward to the customer.
 */
export async function handleRedeem(request: Request): Promise<Response> {
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

  const parsed = redeemInput.safeParse(payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return json(
      { ok: false, code: "validation_error", message: first?.message ?? "Invalid input" },
      400,
    );
  }

  const database = db();
  const { cardCode, phone, rewardId, note } = parsed.data;

  // Resolve the member this terminal is allowed to redeem for. Cards are
  // brand-locked (403 wrong_brand), phones are brand-scoped (404 when the
  // phone has no membership at this brand). Never enrolls — redemption is
  // for existing members only.
  let memberId: string | null = null;
  let resolvedCardCode = cardCode;
  if (ctx) {
    if (cardCode) {
      const member = await getMemberByCardCode(database, cardCode);
      if (member && member.programId !== ctx.programId) {
        return json({ ok: false, code: "wrong_brand", message: "Wrong brand for this card" }, 403);
      }
      memberId = member?.memberId ?? null;
    } else if (phone) {
      const member = await findBrandMemberByPhone(database, phone, ctx.programId);
      if (member) {
        memberId = member.memberId;
        resolvedCardCode = member.cardCode ?? undefined;
      }
    }
  } else if (cardCode) {
    const member = await getMemberByCardCode(database, cardCode);
    memberId = member?.memberId ?? null;
  } else if (phone) {
    const member = await getMemberByPhone(database, phone);
    memberId = member?.memberId ?? null;
  }

  if (!memberId) {
    return json({ ok: false, code: "member_not_found", message: "Loyalty member not found" }, 404);
  }

  const result = await redeemReward(database, {
    memberId,
    rewardId,
    ...(note ? { note } : {}),
  });
  if (!result.ok) {
    const status =
      result.code === "member_not_found" || result.code === "reward_not_found" ? 404 : 422;
    return json(result, status);
  }

  return json({
    ok: true,
    transactionId: result.transactionId,
    rewardId: result.rewardId,
    cost: result.cost,
    balance: result.balance,
    payload: result.payload,
    ...(resolvedCardCode ? { cardCode: resolvedCardCode } : {}),
  });
}
