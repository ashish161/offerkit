import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import {
  scanEarn,
  getMemberByCardCode,
  resolveDefaultQrProgram,
  quickEnroll as quickEnrollMember,
  ensureCardCode,
  normalizePhone,
} from "@offerkit/core/loyalty";
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

  const database = db();

  // Brand mode. Cards are brand-locked; phones are brand-scoped.
  // - Card: reject if it belongs to another program (403 wrong_brand).
  // - Phone: resolve the member *within this brand's program*. If the phone has
  //   no membership here yet, enroll it into this brand's program on the fly
  //   (reusing the shared customer record when the phone is already known),
  //   then credit. This lets one shopper earn at several brands.
  let brandCardCode: string | undefined;
  let preEnrolled = false;
  if (ctx) {
    if (parsed.data.cardCode) {
      const member = await getMemberByCardCode(database, parsed.data.cardCode);
      if (member && member.programId !== ctx.programId) {
        return json({ ok: false, code: "wrong_brand", message: "Wrong brand for this card" }, 403);
      }
    } else if (parsed.data.phone) {
      const existing = await findBrandMemberByPhone(database, parsed.data.phone, ctx.programId);
      if (existing) {
        brandCardCode = existing.cardCode ?? (await ensureCardCode(database, existing.memberId));
      } else {
        const name =
          parsed.data.name ?? (await findCustomerNameByPhone(database, parsed.data.phone));
        if (!name) {
          return json(
            {
              ok: false,
              code: "member_not_found",
              message: "New customer — name required to enroll",
            },
            404,
          );
        }
        const enrolled = await quickEnrollMember(database, {
          name,
          phone: parsed.data.phone,
          programId: ctx.programId,
          ...(parsed.data.email?.trim() ? { email: parsed.data.email.trim() } : {}),
        });
        if (!enrolled.ok) {
          return json(enrolled, enrolled.code === "member_not_found" ? 404 : 422);
        }
        brandCardCode = enrolled.cardCode;
        preEnrolled = true;
      }
    }
  }

  // Major units → minor units (paise), matching LoyaltyEarnFormula semantics.
  const amountMinor = Math.round(parsed.data.amount * 100);

  // Legacy mode: a `name` alongside a phone opts into quick-enroll when the
  // phone is new. Brand mode resolves enrollment above.
  let quickEnroll: { name: string; programId: string; email?: string } | undefined;
  if (!ctx && parsed.data.name && parsed.data.phone) {
    const programId = parsed.data.programId ?? (await resolveDefaultQrProgram(database));
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

  // Namespace the POS bill number per brand: the ledger idempotency key
  // (`event_id = qr:{bill}`) and the mirrored `order.external_id` are both
  // globally unique, so the same bill number at two brands would otherwise
  // collide (409). Prefixing keeps each brand's bills independent — e.g.
  // `BRAND A:TEST-123` and `BRAND B:TEST-123` are two separate credits.
  const billNumber = ctx
    ? `${ctx.brand}:${parsed.data.billNumber}`
    : parsed.data.billNumber;

  const result = await scanEarn(database, {
    cardCode: brandCardCode ?? parsed.data.cardCode,
    phone: ctx ? undefined : parsed.data.phone,
    amountMinor,
    billNumber,
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
  const body =
    brandCardCode !== undefined
      ? { ...result, cardCode: brandCardCode, ...(preEnrolled ? { enrolled: true } : {}) }
      : result;
  // A replay of an already-processed bill is not a new credit — surface it as a
  // conflict so the merchant doesn't believe points were awarded again.
  if (result.alreadyCredited) {
    return json(body, 409);
  }
  return json(body);
}

/**
 * Brand-scoped phone lookup: the member of `programId` whose customer's phone
 * matches (last-10-digit, formatting-insensitive). Unlike core's global
 * `getMemberByPhone`, this ignores memberships in other programs, so a shopper
 * can hold a membership in more than one brand.
 */
export async function findBrandMemberByPhone(
  database: Db,
  phone: string,
  programId: string,
): Promise<{ memberId: string; cardCode: string | null } | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const [row] = await database
    .select({ memberId: schema.loyaltyMember.id, cardCode: schema.loyaltyMember.cardCode })
    .from(schema.loyaltyMember)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.loyaltyMember.customerId))
    .where(
      and(
        eq(schema.loyaltyMember.programId, programId),
        sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '\\D', '', 'g'), 10) = ${normalized}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Customer name for a known phone, used to auto-enroll them into a new brand. */
async function findCustomerNameByPhone(database: Db, phone: string): Promise<string | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const [row] = await database
    .select({ name: schema.customer.name })
    .from(schema.customer)
    .where(
      sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '\\D', '', 'g'), 10) = ${normalized}`,
    )
    .limit(1);
  return row?.name ?? null;
}
