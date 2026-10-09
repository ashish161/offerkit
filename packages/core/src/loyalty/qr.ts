import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import type { LoyaltyEarnFormula } from "@offerkit/db/schema";
import { generateCode } from "../codes/generate.ts";
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
  note?: string;
}

export interface ScanEarnOutcome extends EarnOutcome {
  memberId: string;
  basePoints: number;
  earningRuleId: string | null;
  alreadyCredited: boolean;
  billNumber: string;
}

/** Prefix isolates QR bill event ids from other ledger event ids. */
export function billEventId(billNumber: string): string {
  return `qr:${billNumber}`;
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
  if (!member) {
    return {
      ok: false,
      code: "member_not_found",
      message: input.cardCode ? "Unknown card code" : "No enrolled member for that phone",
    };
  }

  const eventId = billEventId(billNumber);
  const prior = await db.query.loyaltyTransaction.findFirst({
    where: and(
      eq(schema.loyaltyTransaction.memberId, member.memberId),
      eq(schema.loyaltyTransaction.eventId, eventId),
    ),
  });
  if (prior) {
    return {
      ok: true,
      transactionId: prior.id,
      delta: prior.delta,
      balance: member.balance,
      lifetimePoints: member.lifetimePoints,
      tierId: member.currentTierId,
      memberId: member.memberId,
      basePoints: prior.delta,
      earningRuleId: prior.earningRuleId,
      alreadyCredited: true,
      billNumber,
    };
  }

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

  const result = await earn(db, {
    memberId: member.memberId,
    basePoints,
    earningRuleId: rule?.id,
    eventId,
    note: input.note ?? `QR scan · bill ${billNumber}`,
  });
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
