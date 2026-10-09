import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import type { LoyaltyEarnFormula } from "@offerkit/db/schema";
import { generateCode } from "../codes/generate.ts";
import { emitEvent } from "../events/index.ts";
import { earn, type LoyaltyResult, type EarnOutcome } from "./index.ts";

/**
 * QR Loyalty POC — engine-side helpers.
 *
 * Everything here is UI-agnostic: the dashboard, a public route handler,
 * the worker, or the CLI can all call it. No HTTP or React concerns.
 */

/** Event tag used to pick the earning rule for QR scans. */
export const QR_SCAN_EVENT = "qr.scan";

/**
 * Postgres unique-violation (SQLSTATE 23505) detector, driver-agnostic.
 * Drizzle wraps query errors in `DrizzleQueryError` with the driver error on
 * `.cause`, so walk the chain before giving up.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && "code" in current && current.code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Convert a bill amount into points using a stored earning-rule formula.
 * `amountMinor` is the bill in minor currency units (e.g. paise).
 *
 * - fixed:    `value` points regardless of amount
 * - per_cents: floor(amountMinor / divisor) — divisor=100 → 1 pt per major unit
 * - custom:   caller must supply points; returns null (no evaluation possible)
 *
 * Returns 0 for invalid/insufficient amounts so callers can reject cleanly.
 */
export function computeEarnPoints(
  formula: LoyaltyEarnFormula,
  amountMinor: number,
): number | null {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 0;
  switch (formula.kind) {
    case "fixed":
      return Math.max(0, formula.value ?? 0);
    case "per_cents": {
      // missing divisor defaults to 100 → 1 pt per major currency unit
      const divisor = formula.divisor ?? 100;
      if (!Number.isFinite(divisor) || divisor <= 0) return 0;
      return Math.floor(amountMinor / divisor);
    }
    case "custom":
      return null;
  }
}

/**
 * Resolve the earning rule a QR scan should use for a program.
 * Preference: active rule tagged `qr.scan`, else any active rule.
 * null when the program has none (caller falls back to a default rate).
 */
export async function resolveScanEarningRule(
  db: Db,
  programId: string,
): Promise<{ id: string; formula: LoyaltyEarnFormula } | null> {
  const rules = await db
    .select()
    .from(schema.loyaltyEarningRule)
    .where(
      and(
        eq(schema.loyaltyEarningRule.programId, programId),
        eq(schema.loyaltyEarningRule.active, "yes"),
      ),
    );
  const tagged = rules.find((r) => r.event === QR_SCAN_EVENT);
  const rule = tagged ?? rules[0];
  return rule ? { id: rule.id, formula: rule.formula } : null;
}

const CARD_CODE_LENGTH = 8;

/**
 * Return the member's card code, minting and persisting one on first use.
 * Codes are 8 chars, uppercase, confusable characters excluded (0/O/1/l/I)
 * so they are safe to read off a screen and type at a POS terminal.
 */
export async function ensureCardCode(db: Db, memberId: string): Promise<string> {
  const [member] = await db
    .select({ cardCode: schema.loyaltyMember.cardCode })
    .from(schema.loyaltyMember)
    .where(eq(schema.loyaltyMember.id, memberId))
    .limit(1);
  if (!member) {
    throw new Error(`loyalty member ${memberId} not found`);
  }
  if (member.cardCode) return member.cardCode;

  const exists = async (code: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: schema.loyaltyMember.id })
      .from(schema.loyaltyMember)
      .where(eq(schema.loyaltyMember.cardCode, code))
      .limit(1);
    return Boolean(row);
  };

  let code = generateCode({ length: CARD_CODE_LENGTH, charset: "uppercase" });
  for (let attempt = 0; attempt < 10 && (await exists(code)); attempt++) {
    code = generateCode({ length: CARD_CODE_LENGTH, charset: "uppercase" });
  }
  if (await exists(code)) {
    throw new Error("could not mint a unique card code");
  }

  await db
    .update(schema.loyaltyMember)
    .set({ cardCode: code, updatedAt: new Date() })
    .where(eq(schema.loyaltyMember.id, memberId));
  return code;
}

export interface CardLookup {
  memberId: string;
  customerId: string;
  programId: string;
  balance: number;
  lifetimePoints: number;
  currentTierId: string | null;
}

/** Resolve a card code to its member. null when the code is unknown. */
export async function getMemberByCardCode(db: Db, cardCode: string): Promise<CardLookup | null> {
  const normalized = cardCode.trim().toUpperCase();
  if (!normalized) return null;
  const [member] = await db
    .select({
      memberId: schema.loyaltyMember.id,
      customerId: schema.loyaltyMember.customerId,
      programId: schema.loyaltyMember.programId,
      balance: schema.loyaltyMember.balance,
      lifetimePoints: schema.loyaltyMember.lifetimePoints,
      currentTierId: schema.loyaltyMember.currentTierId,
    })
    .from(schema.loyaltyMember)
    .where(eq(schema.loyaltyMember.cardCode, normalized))
    .limit(1);
  return member ?? null;
}

const PHONE_LOOKUP_COLUMNS = {
  memberId: schema.loyaltyMember.id,
  customerId: schema.loyaltyMember.customerId,
  programId: schema.loyaltyMember.programId,
  balance: schema.loyaltyMember.balance,
  lifetimePoints: schema.loyaltyMember.lifetimePoints,
  currentTierId: schema.loyaltyMember.currentTierId,
} as const;

/**
 * Normalize a phone number to its last 10 digits for matching, so
 * `+91 90964 44567`, `090964 44567`, and `9096444567` all resolve to the
 * same customer. Returns null when there are too few digits to be a phone.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Resolve a member by the customer's phone number (last-10-digit match,
 * formatting-insensitive). Phone is an alias, never the canonical
 * identifier — member identity remains the card code + customer uuid.
 * null when no customer matches or they are not enrolled.
 */
export async function getMemberByPhone(db: Db, phone: string): Promise<CardLookup | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const [member] = await db
    .select(PHONE_LOOKUP_COLUMNS)
    .from(schema.loyaltyMember)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.loyaltyMember.customerId))
    .where(
      sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '\\D', '', 'g'), 10) = ${normalized}`,
    )
    .limit(1);
  return member ?? null;
}

export interface ScanEarnInput {
  /** Card code shown on the customer's card. Prefer this over phone. */
  cardCode?: string;
  /** Phone alias — used only when no matching card code is supplied. */
  phone?: string;
  /** Bill amount in minor currency units (paise). */
  amountMinor: number;
  /** Unique bill/invoice number from the POS — the idempotency key. */
  billNumber: string;
  /**
   * Quick-enroll: when `phone` matches no member, create a customer + member
   * on the spot and credit points to it. Requires `name` and a `programId`.
   */
  quickEnroll?: { name: string; programId: string; email?: string };
  note?: string;
}

export interface ScanEarnOutcome extends EarnOutcome {
  memberId: string;
  basePoints: number;
  earningRuleId: string | null;
  alreadyCredited: boolean;
  billNumber: string;
  /** Minted card code when the member was quick-enrolled from a bare phone. */
  cardCode?: string;
  /** True when this scan created the customer + member on the spot. */
  enrolled?: boolean;
  /**
   * OfferKit order mirrored from the scan (keyed by bill number). Null when no
   * order was created — e.g. a replayed bill.
   */
  orderId?: string | null;
}

/** Prefix isolates QR bill event ids from other ledger event ids. */
export function billEventId(billNumber: string): string {
  return `qr:${billNumber}`;
}

export interface QuickEnrollInput {
  name: string;
  phone: string;
  programId: string;
  email?: string;
}

export interface QuickEnrollOutcome extends CardLookup {
  cardCode: string;
  /** False when an existing customer+program membership was reused. */
  created: boolean;
}

/**
 * Quick-enroll a customer from a bare phone on the spot:
 * create the customer (if that phone is unknown), enroll them as a member of
 * `programId`, and mint their card code. Idempotent: if the phone already maps
 * to a member of this program, returns that member with `created: false`.
 *
 * Phone is still an alias, not an identifier — identity remains the customer
 * uuid + card code. The `name` must come from the merchant (the terminal asks
 * for it), so we never fabricate a customer from a bare number.
 */
export async function quickEnroll(
  db: Db,
  input: QuickEnrollInput,
): Promise<LoyaltyResult<QuickEnrollOutcome>> {
  if (input.programId) input.programId = input.programId.trim();
  if (!input.programId) {
    return { ok: false, code: "validation_error", message: "Program is required" };
  }
  const name = input.name?.trim();
  if (!name) {
    return { ok: false, code: "validation_error", message: "Customer name is required" };
  }
  const phone = normalizePhone(input.phone);
  if (!phone) {
    return { ok: false, code: "validation_error", message: "Phone must have at least 10 digits" };
  }

  const [program] = await db
    .select({ id: schema.loyaltyProgram.id })
    .from(schema.loyaltyProgram)
    .where(eq(schema.loyaltyProgram.id, input.programId))
    .limit(1);
  if (!program) {
    return { ok: false, code: "program_not_found", message: "Loyalty program not found" };
  }

  // Find-or-create the customer + membership in a transaction. `ensureCardCode`
  // runs AFTER commit (a write inside the open transaction would deadlock a
  // single-connection test DB / PGlite).
  const { memberId, customerId, programId: resolvedProgramId, created } = await db.transaction(
    async (tx) => {
      const [existingCustomer] = await tx
        .select({ id: schema.customer.id })
        .from(schema.customer)
        .where(
          sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '\\D', '', 'g'), 10) = ${phone}`,
        )
        .limit(1);
      const existingCustomerId = existingCustomer?.id ?? null;

      const [existingMember] = existingCustomerId
        ? await tx
            .select({
              id: schema.loyaltyMember.id,
              customerId: schema.loyaltyMember.customerId,
              programId: schema.loyaltyMember.programId,
            })
            .from(schema.loyaltyMember)
            .where(
              and(
                eq(schema.loyaltyMember.customerId, existingCustomerId),
                eq(schema.loyaltyMember.programId, input.programId),
              ),
            )
            .limit(1)
        : [];
      if (existingMember) {
        return {
          memberId: existingMember.id,
          customerId: existingMember.customerId,
          programId: existingMember.programId,
          created: false,
        };
      }

      let cid = existingCustomerId;
      if (!cid) {
        const [insertedCustomer] = await tx
          .insert(schema.customer)
          .values({ name, phone: input.phone, ...(input.email?.trim() ? { email: input.email.trim() } : {}) })
          .returning({ id: schema.customer.id });
        cid = insertedCustomer?.id ?? null;
        if (!cid) throw new Error("customer insert failed");
      }

      const [insertedMember] = await tx
        .insert(schema.loyaltyMember)
        .values({ customerId: cid, programId: input.programId })
        .returning({ id: schema.loyaltyMember.id });
      if (!insertedMember) throw new Error("loyalty member insert failed");

      return {
        memberId: insertedMember.id,
        customerId: cid,
        programId: input.programId,
        created: true,
      };
    },
  );

  const cardCode = await ensureCardCode(db, memberId);
  const [memberRow] = await db
    .select({
      balance: schema.loyaltyMember.balance,
      lifetimePoints: schema.loyaltyMember.lifetimePoints,
      currentTierId: schema.loyaltyMember.currentTierId,
    })
    .from(schema.loyaltyMember)
    .where(eq(schema.loyaltyMember.id, memberId))
    .limit(1);
  if (!memberRow) {
    return { ok: false, code: "member_not_found", message: "Loyalty member not found" };
  }

  return {
    ok: true,
    memberId,
    customerId,
    programId: resolvedProgramId,
    balance: memberRow.balance,
    lifetimePoints: memberRow.lifetimePoints,
    currentTierId: memberRow.currentTierId,
    cardCode,
    created,
  };
}

/**
 * Resolve the default loyalty program for quick-enroll: the most recently
 * created `LOYALTY_PROGRAM` campaign. null when none exists. Status is not a
 * filter — the admin may keep a program in draft while trialing the flow.
 */
export async function resolveDefaultQrProgram(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.loyaltyProgram.id })
    .from(schema.loyaltyProgram)
    .innerJoin(schema.campaign, eq(schema.campaign.id, schema.loyaltyProgram.campaignId))
    .where(
      and(
        eq(schema.campaign.type, "LOYALTY_PROGRAM"),
        sql`${schema.campaign.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(schema.campaign.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Merchant scan flow: card code (or phone alias) + bill amount → credited points.
 *
 * 1. resolve member by card code, falling back to phone when given
 * 2. reject bills that were already processed (idempotency by bill number)
 * 3. resolve the program's scan earning rule (or default 1 pt / major unit)
 * 4. compute points from the bill amount
 * 5. credit via earn() (tier multiplier applies)
 *
 * The bill number is the idempotency key: retrying the same bill returns the
 * original result with `alreadyCredited: true` instead of double-crediting.
 */
export async function scanEarn(db: Db, input: ScanEarnInput): Promise<LoyaltyResult<ScanEarnOutcome>> {
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, code: "validation_error", message: "Bill amount must be positive" };
  }
  if (!input.cardCode && !input.phone) {
    return { ok: false, code: "validation_error", message: "Card code or phone is required" };
  }
  const billNumber = input.billNumber?.trim();
  if (!billNumber) {
    return { ok: false, code: "validation_error", message: "Bill number is required" };
  }

  let member = input.cardCode ? await getMemberByCardCode(db, input.cardCode) : null;
  if (!member && input.phone) member = await getMemberByPhone(db, input.phone);

  let enrolled: { cardCode: string; created: boolean } | undefined;
  if (!member && input.phone && input.quickEnroll) {
    const enrolledResult = await quickEnroll(db, {
      name: input.quickEnroll.name,
      phone: input.phone,
      programId: input.quickEnroll.programId,
      email: input.quickEnroll.email,
    });
    if (!enrolledResult.ok) return enrolledResult;
    member = {
      memberId: enrolledResult.memberId,
      customerId: enrolledResult.customerId,
      programId: enrolledResult.programId,
      balance: enrolledResult.balance,
      lifetimePoints: enrolledResult.lifetimePoints,
      currentTierId: enrolledResult.currentTierId,
    };
    enrolled = { cardCode: enrolledResult.cardCode, created: enrolledResult.created };
  }

  if (!member) {
    return {
      ok: false,
      code: "member_not_found",
      message: input.cardCode ? "Unknown card code" : "No enrolled member for that phone",
    };
  }

  const creditMember = member;
  const eventId = billEventId(billNumber);

  /**
   * Build the idempotent-replay result for a bill that was already credited.
   * `member` may be a fresh snapshot (the concurrent-race path re-reads it).
   */
  const buildReplay = (
    prior: typeof schema.loyaltyTransaction.$inferSelect,
    m: { balance: number; lifetimePoints: number; currentTierId: string | null },
  ): LoyaltyResult<ScanEarnOutcome> => {
    if (prior.memberId !== creditMember.memberId) {
      return {
        ok: false,
        code: "bill_already_processed",
        message: "Bill number was already processed for another member",
      };
    }
    return {
      ok: true,
      transactionId: prior.id,
      delta: prior.delta,
      balance: m.balance,
      lifetimePoints: m.lifetimePoints,
      tierId: m.currentTierId,
      memberId: creditMember.memberId,
      basePoints: prior.delta,
      earningRuleId: prior.earningRuleId,
      alreadyCredited: true,
      billNumber,
      ...(enrolled ? { cardCode: enrolled.cardCode, enrolled: enrolled.created } : {}),
    };
  };

  const prior = await db.query.loyaltyTransaction.findFirst({
    where: eq(schema.loyaltyTransaction.eventId, eventId),
  });
  if (prior) return buildReplay(prior, creditMember);

  const rule = await resolveScanEarningRule(db, member.programId);
  // Fallback when no rule is configured: 1 point per major currency unit
  // (divisor=100 → floor(paise / 100)).
  const formula: LoyaltyEarnFormula = rule?.formula ?? {
    kind: "per_cents",
    divisor: 100,
  };
  const basePoints = computeEarnPoints(formula, input.amountMinor);
  if (basePoints === null) {
    return {
      ok: false,
      code: "validation_error",
      message: "Earning rule requires caller-supplied points",
    };
  }
  if (basePoints <= 0) {
    return {
      ok: false,
      code: "insufficient_points",
      message: "Bill amount is below the minimum for earning points",
    };
  }

  let orderId: string | null = null;
  let result: LoyaltyResult<EarnOutcome>;
  try {
    result = await earn(db, {
      memberId: creditMember.memberId,
      basePoints,
      earningRuleId: rule?.id,
      eventId,
      note: input.note ?? `QR scan · bill ${billNumber}`,
      onEarned: async (outcome, tx) => {
        // Mirror the scanned bill as an OfferKit order so operators can search it
        // in the dashboard. We have no POS integration, so this scan IS the only
        // purchase signal. Keyed by bill number (unique externalId) for
        // idempotency; the POS stays authoritative for itemised sales.
        const [row] = await tx
          .select({ currency: schema.campaign.currency })
          .from(schema.loyaltyProgram)
          .innerJoin(schema.campaign, eq(schema.campaign.id, schema.loyaltyProgram.campaignId))
          .where(eq(schema.loyaltyProgram.id, creditMember.programId))
          .limit(1);
        const [order] = await tx
          .insert(schema.order)
          .values({
            externalId: billNumber,
            customerId: creditMember.customerId,
            amount: input.amountMinor,
            currency: row?.currency ?? "USD",
            status: "PAID",
            items: [],
            metadata: {
              source: "qr.scan",
              memberId: creditMember.memberId,
              basePoints,
              delta: outcome.delta,
            },
          })
          .returning({ id: schema.order.id });
        orderId = order?.id ?? null;

        await emitEvent(tx, {
          type: "loyalty.points.earned",
          entityId: creditMember.memberId,
          payload: {
            memberId: creditMember.memberId,
            customerId: creditMember.customerId,
            programId: creditMember.programId,
            billNumber,
            amountMinor: input.amountMinor,
            basePoints,
            delta: outcome.delta,
            balance: outcome.balance,
            lifetimePoints: outcome.lifetimePoints,
            tierId: outcome.tierId,
            earningRuleId: rule?.id ?? null,
            orderId,
            source: "qr.scan",
          },
        });
      },
    });
  } catch (err) {
    // Concurrent scan of the same bill: this call lost the race and the unique
    // index on loyalty_transaction.event_id rejected the duplicate credit. The
    // whole transaction rolled back, so re-read and return the winner's credit
    // as an idempotent replay instead of surfacing a 500.
    if (!isUniqueViolation(err)) throw err;
    const winner = await db.query.loyaltyTransaction.findFirst({
      where: eq(schema.loyaltyTransaction.eventId, eventId),
    });
    if (winner) {
      const [snap] = await db
        .select({
          balance: schema.loyaltyMember.balance,
          lifetimePoints: schema.loyaltyMember.lifetimePoints,
          currentTierId: schema.loyaltyMember.currentTierId,
        })
        .from(schema.loyaltyMember)
        .where(eq(schema.loyaltyMember.id, creditMember.memberId))
        .limit(1);
      return buildReplay(winner, snap ?? creditMember);
    }
    // No ledger row for this bill — the collision is an order with the same
    // externalId (e.g. pushed by a real POS integration). Treat as processed.
    const clashingOrder = await db.query.order.findFirst({
      where: eq(schema.order.externalId, billNumber),
    });
    if (clashingOrder) {
      return {
        ok: false,
        code: "bill_already_processed",
        message: "Bill number was already processed",
      };
    }
    throw err;
  }
  if (!result.ok) return result;

  return {
    ok: true,
    transactionId: result.transactionId,
    delta: result.delta,
    balance: result.balance,
    lifetimePoints: result.lifetimePoints,
    tierId: result.tierId,
    memberId: member.memberId,
    basePoints,
    earningRuleId: rule?.id ?? null,
    alreadyCredited: false,
    billNumber,
    orderId,
    ...(enrolled ? { cardCode: enrolled.cardCode, enrolled: enrolled.created } : {}),
  };
}

/** Card-page projection: member + customer + tier display data. */
export interface CardDetails {
  memberId: string;
  cardCode: string;
  balance: number;
  lifetimePoints: number;
  customerName: string | null;
  tierName: string | null;
  tierThreshold: number | null;
  nextTierName: string | null;
  nextTierThreshold: number | null;
}

export async function getCardDetails(db: Db, cardCode: string): Promise<CardDetails | null> {
  const normalized = cardCode.trim().toUpperCase();
  if (!normalized) return null;

  const [row] = await db
    .select({
      memberId: schema.loyaltyMember.id,
      cardCode: schema.loyaltyMember.cardCode,
      balance: schema.loyaltyMember.balance,
      lifetimePoints: schema.loyaltyMember.lifetimePoints,
      programId: schema.loyaltyMember.programId,
      currentTierId: schema.loyaltyMember.currentTierId,
      customerName: schema.customer.name,
      tierName: schema.loyaltyTier.name,
      tierThreshold: schema.loyaltyTier.threshold,
    })
    .from(schema.loyaltyMember)
    .where(eq(schema.loyaltyMember.cardCode, normalized))
    .leftJoin(schema.customer, eq(schema.loyaltyMember.customerId, schema.customer.id))
    .leftJoin(schema.loyaltyTier, eq(schema.loyaltyMember.currentTierId, schema.loyaltyTier.id))
    .limit(1);
  if (!row || !row.cardCode) return null;

  const tiers = await db
    .select({ name: schema.loyaltyTier.name, threshold: schema.loyaltyTier.threshold })
    .from(schema.loyaltyTier)
    .where(eq(schema.loyaltyTier.programId, row.programId));
  const next =
    tiers
      .filter((t) => t.threshold > row.lifetimePoints)
      .sort((a, b) => a.threshold - b.threshold)[0] ?? null;

  return {
    memberId: row.memberId,
    cardCode: row.cardCode,
    balance: row.balance,
    lifetimePoints: row.lifetimePoints,
    customerName: row.customerName,
    tierName: row.tierName,
    tierThreshold: row.tierThreshold,
    nextTierName: next?.name ?? null,
    nextTierThreshold: next?.threshold ?? null,
  };
}
