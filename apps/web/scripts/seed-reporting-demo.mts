import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { getDb, closeDb } from "@offerkit/db/client";
import * as schema from "@offerkit/db/schema";

type Db = ReturnType<typeof getDb>;
type BrandCfg = { programId: string; pin: string };
type TxRow = Omit<typeof schema.loyaltyTransaction.$inferInsert, "memberId">;

const args = new Set(process.argv.slice(2));
const yes = args.has("--yes");
const force = args.has("--force");
const perBrand = (() => {
  const arg = [...args].find((a) => a.startsWith("--per-brand="));
  const n = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
})();

if (!process.env["DATABASE_URL"]) {
  console.error(
    "DATABASE_URL is not set. Run via `pnpm --filter @offerkit/web seed-reporting-demo` (loads ../../.env).",
  );
  process.exit(1);
}
const dbUrl = new URL(process.env["DATABASE_URL"]);

/** Dev-only guard: refuse to seed a non-local database. */
function assertLocalDatabase(): void {
  if (force) return;
  const host = dbUrl.hostname;
  const local = host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local) {
    console.error(
      `seed-reporting-demo is dev-only and refuses to run against host "${host}". ` +
        "Pass --force only if you are certain the target holds no live data.",
    );
    process.exit(1);
  }
}

/**
 * Seed realistic per-brand loyalty activity for the read-only report page
 * (`/reports`) and the dashboard.
 *
 * - Brands come from `MULTI_TENANT_BRANDS` (same config the app uses).
 * - Faithfully simulates the engine's earn logic (tier multiplier from the
 *   member's current tier, tier re-picked after each earn) so balances,
 *   lifetimes and tiers are internally consistent.
 * - Writes complete rows to every table the reports read: `customer`,
 *   `loyalty_member`, `loyalty_transaction`, `order`, `event`.
 * - Activity is backdated across ~26 days so the daily-activity table and
 *   "recent scans" look real.
 * - Idempotent: re-running deletes only its own prior rows (customers marked
 *   `external_id = 'demo-seed:%'`), never real data.
 *
 * Flags: --per-brand=N (default 7), --yes (skip prompt), --force (bypass guard).
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261010);
const rand = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

const CARD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const usedCodes = new Set<string>();
function newCardCode(): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 8; i++) s += CARD_ALPHABET[Math.floor(rng() * CARD_ALPHABET.length)];
    if (!usedCodes.has(s)) {
      usedCodes.add(s);
      return s;
    }
  }
}

const FIRST = [
  "Priya", "Rohan", "Ananya", "Vikram", "Sneha", "Arjun", "Karan", "Neha",
  "Aditya", "Meera", "Farhan", "Isha", "Dev", "Tara", "Kabir", "Riya",
  "Nikhil", "Pooja", "Sameer", "Divya",
];
const LAST = [
  "Sharma", "Mehta", "Iyer", "Singh", "Reddy", "Nair", "Patel", "Gupta",
  "Rao", "Joshi", "Khan", "Verma", "Kapoor", "Bose", "Chopra", "Menon",
];
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const NAME_POOL = shuffle(
  FIRST.map((f) => `${f} ${pick(LAST)}`),
).slice(0, 32);

const AMOUNTS = [450, 650, 900, 1200, 1600, 2100, 2800, 3500, 4600, 5900, 7200, 8800];
const REDEEM_POINTS = [100, 200, 250, 300, 500, 750];

const now = Date.now();
function dateDaysAgo(days: number): Date {
  const d = new Date(now - days * 86_400_000);
  d.setHours(rand(9, 21), rand(0, 59), rand(0, 59), 0);
  return d;
}

interface Activity {
  daysAgo: number;
  kind: "earn" | "redeem";
  amountMajor?: number;
  points?: number;
}
function makeActivity(): Activity[] {
  const n = rand(2, 7);
  const events: Activity[] = [];
  let cur = 26;
  for (let i = 0; i < n; i++) {
    cur -= rand(1, 5);
    if (cur < 1) break;
    events.push({ daysAgo: cur, kind: "earn", amountMajor: pick(AMOUNTS) });
  }
  if (events.length >= 3 && rng() < 0.5) {
    // Redeem near the end of the window so it happens after enough earns.
    events.push({ daysAgo: 1, kind: "redeem", points: pick(REDEEM_POINTS) });
  }
  events.sort((a, b) => b.daysAgo - a.daysAgo); // oldest → newest
  return events;
}

interface TierRow {
  id: string;
  threshold: number;
  earnMultiplier: number;
}
function pickTier(tiers: TierRow[], lifetimePoints: number): TierRow | null {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let chosen: TierRow | null = null;
  for (const t of sorted) {
    if (t.threshold <= lifetimePoints) chosen = t;
    else break;
  }
  return chosen;
}

const DEFAULT_TIERS: { name: string; threshold: number; earnMultiplier: number }[] = [
  { name: "Member", threshold: 0, earnMultiplier: 10000 },
  { name: "Plus", threshold: 250, earnMultiplier: 12500 },
  { name: "VIP", threshold: 1000, earnMultiplier: 15000 },
  { name: "Elite", threshold: 5000, earnMultiplier: 20000 },
];

const main = async (): Promise<void> => {
  assertLocalDatabase();

  const db = getDb();

  // Brands come from the DB (Settings -> Brands) and fall back to the legacy
  // MULTI_TENANT_BRANDS env map only when no DB brands exist — matching the
  // app's authorizeScan precedence.
  let brands: { name: string; programId: string }[] = await db
    .select({ name: schema.qrBrand.name, programId: schema.qrBrand.programId })
    .from(schema.qrBrand)
    .where(and(eq(schema.qrBrand.active, true), isNull(schema.qrBrand.deletedAt)));

  if (brands.length === 0) {
    const brandsEnv = process.env["MULTI_TENANT_BRANDS"];
    if (brandsEnv) {
      try {
        const parsed = JSON.parse(brandsEnv) as Record<string, BrandCfg>;
        brands = Object.entries(parsed)
          .filter(([, v]) => v && typeof v.programId === "string")
          .map(([name, v]) => ({ name, programId: v.programId }));
      } catch {
        brands = [];
      }
    }
  }
  if (brands.length === 0) {
    console.error(
      "No QR brands found. Create brands in Settings -> Brands (or set MULTI_TENANT_BRANDS).",
    );
    process.exit(1);
  }

  const programIds = brands.map((b) => b.programId);

  const programRows = await db
    .select({
      programId: schema.loyaltyProgram.id,
      brand: schema.campaign.name,
      currency: schema.campaign.currency,
    })
    .from(schema.loyaltyProgram)
    .innerJoin(schema.campaign, eq(schema.campaign.id, schema.loyaltyProgram.campaignId))
    .where(inArray(schema.loyaltyProgram.id, programIds));
  const programMap = new Map(programRows.map((r) => [r.programId, r]));
  for (const b of brands) {
    if (!programMap.has(b.programId)) {
      console.error(`No loyalty program found for brand "${b.name}" (${b.programId}).`);
      process.exit(1);
    }
  }

  const ruleRows = await db
    .select({ id: schema.loyaltyEarningRule.id, programId: schema.loyaltyEarningRule.programId })
    .from(schema.loyaltyEarningRule)
    .where(
      and(
        inArray(schema.loyaltyEarningRule.programId, programIds),
        eq(schema.loyaltyEarningRule.event, "qr.scan"),
        eq(schema.loyaltyEarningRule.active, "yes"),
      ),
    );
  const ruleMap = new Map<string, string>();
  for (const r of ruleRows) if (!ruleMap.has(r.programId)) ruleMap.set(r.programId, r.id);

  // Ensure every brand has a tier ladder so seeded members land in real tiers.
  const existingTiers = await db
    .select({
      id: schema.loyaltyTier.id,
      programId: schema.loyaltyTier.programId,
      threshold: schema.loyaltyTier.threshold,
      earnMultiplier: schema.loyaltyTier.earnMultiplier,
    })
    .from(schema.loyaltyTier)
    .where(inArray(schema.loyaltyTier.programId, programIds));
  const tiersByProgram = new Map<string, TierRow[]>();
  for (const b of brands) {
    const list = existingTiers
      .filter((t) => t.programId === b.programId)
      .map((t) => ({ id: t.id, threshold: t.threshold, earnMultiplier: t.earnMultiplier }));
    tiersByProgram.set(b.programId, list);
  }
  for (const b of brands) {
    if ((tiersByProgram.get(b.programId) ?? []).length > 0) continue;
    const inserted = await db
      .insert(schema.loyaltyTier)
      .values(
        DEFAULT_TIERS.map((t, i) => ({
          programId: b.programId,
          name: t.name,
          threshold: t.threshold,
          earnMultiplier: t.earnMultiplier,
          sortOrder: i,
        })),
      )
      .returning({
        id: schema.loyaltyTier.id,
        threshold: schema.loyaltyTier.threshold,
        earnMultiplier: schema.loyaltyTier.earnMultiplier,
      });
    tiersByProgram.set(b.programId, inserted);
  }

  // Ensure enough unique names.
  const needed = 1 + (perBrand - 1) * brands.length;
  if (NAME_POOL.length < needed) {
    console.error(`Need ${needed} names, have ${NAME_POOL.length}.`);
    process.exit(1);
  }
  const names = NAME_POOL.slice(0, needed);

  // Cleanup prior seed rows (only ours).
  const priorCustomers = await db
    .select({ id: schema.customer.id })
    .from(schema.customer)
    .where(like(schema.customer.externalId, "demo-seed:%"));
  const priorCustomerIds = priorCustomers.map((c) => c.id);
  const priorMemberIds = priorCustomerIds.length
    ? (
        await db
          .select({ id: schema.loyaltyMember.id })
          .from(schema.loyaltyMember)
          .where(inArray(schema.loyaltyMember.customerId, priorCustomerIds))
      ).map((m) => m.id)
    : [];

  console.info("seed-reporting-demo: realistic per-brand activity");
  console.info(`  brands:  ${brands.map((b) => `${b.name} (${b.programId.slice(0, 8)}…)`).join(", ")}`);
  console.info(`  members: ${perBrand} per brand`);
  console.info(`  will replace ${priorCustomerIds.length} prior seed customer(s)`);

  if (!yes) {
    const rl = createInterface({ input: processStdin, output: processStdout });
    const answer = await rl.question("Seed demo reporting data now? [y/N] ");
    rl.close();
    if (!/^y/i.test(answer.trim())) {
      console.info("aborted — nothing written.");
      await closeDb();
      return;
    }
  }

  await db.delete(schema.order).where(like(schema.order.externalId, "%:DEMO-%"));
  if (priorMemberIds.length) {
    await db.delete(schema.event).where(inArray(schema.event.entityId, priorMemberIds));
    await db.delete(schema.customer).where(inArray(schema.customer.id, priorCustomerIds));
  }

  let phoneSeq = 0;
  const nextPhone = () => `98${String(10_000_000 + phoneSeq++).slice(0, 8)}`;

  let billSeq = 0;
  const nextBill = (brand: string) => `${brand}:DEMO-${String(++billSeq).padStart(4, "0")}`;

  let totalMembers = 0;
  let totalEarns = 0;
  let totalRedeems = 0;
  let totalBills = 0;
  let totalPoints = 0;

  const sharedName = names[0] as string;
  const sharedPhone = nextPhone();
  const sharedCustomerId = await insertCustomer(db, sharedName, sharedPhone);

  async function insertCustomer(d: Db, name: string, phone: string): Promise<string> {
    const [row] = await d
      .insert(schema.customer)
      .values({ name, phone, externalId: `demo-seed:${phone}` })
      .returning({ id: schema.customer.id });
    if (!row) throw new Error("customer insert failed");
    return row.id;
  }

  for (let bi = 0; bi < brands.length; bi++) {
    const brand = brands[bi] as { name: string; programId: string };
    const prog = programMap.get(brand.programId);
    if (!prog) throw new Error("program missing");
    const currency = prog.currency;
    const divisor = 1000;
    const tiers = tiersByProgram.get(brand.programId) ?? [];
    const ruleId = ruleMap.get(brand.programId) ?? null;

    for (let mi = 0; mi < perBrand; mi++) {
      const isShared = mi === 0;
      const name = isShared ? sharedName : (names[1 + bi * (perBrand - 1) + (mi - 1)] as string);
      const customerId = isShared
        ? sharedCustomerId
        : await insertCustomer(db, name, nextPhone());

      const activity = makeActivity();
      let balance = 0;
      let lifetime = 0;
      let currentTierId: string | null = null;
      const txRows: TxRow[] = [];
      const earnRows: {
        bill: string;
        amountMinor: number;
        basePoints: number;
        delta: number;
        createdAt: Date;
      }[] = [];
      let enrolledAt: Date | null = null;

      for (const ev of activity) {
        const createdAt = dateDaysAgo(ev.daysAgo);
        if (!enrolledAt || createdAt < enrolledAt) enrolledAt = createdAt;

        if (ev.kind === "earn") {
          const amountMajor = ev.amountMajor ?? 1000;
          const amountMinor = amountMajor * 100;
          const basePoints = Math.floor(amountMinor / divisor);
          const current = tiers.find((t) => t.id === currentTierId);
          const multiplier = current ? current.earnMultiplier : 10000;
          const delta = Math.floor((basePoints * multiplier) / 10000);
          if (delta <= 0) continue;
          balance += delta;
          lifetime += delta;
          currentTierId = pickTier(tiers, lifetime)?.id ?? null;

          const bill = nextBill(brand.name);
          txRows.push({
            delta,
            balanceAfter: balance,
            reason: "EARN",
            earningRuleId: ruleId,
            eventId: `qr:${bill}`,
            note: `QR scan · bill ${bill}`,
            createdAt,
          });
          earnRows.push({ bill, amountMinor, basePoints, delta, createdAt });
          totalEarns++;
          totalPoints += delta;
        } else {
          const points = Math.min(ev.points ?? 100, balance);
          if (points < 100) continue;
          balance -= points;
          txRows.push({
            delta: -points,
            balanceAfter: balance,
            reason: "REDEEM",
            note: "Redeemed points",
            createdAt,
          });
          totalRedeems++;
        }
      }

      if (txRows.length === 0) continue;

      const [member] = await db
        .insert(schema.loyaltyMember)
        .values({
          customerId,
          programId: brand.programId,
          balance,
          lifetimePoints: lifetime,
          currentTierId,
          cardCode: newCardCode(),
          enrolledAt: enrolledAt ?? new Date(now),
          createdAt: enrolledAt ?? new Date(now),
        })
        .returning({ id: schema.loyaltyMember.id, cardCode: schema.loyaltyMember.cardCode });
      if (!member) throw new Error("member insert failed");
      totalMembers++;

      await db
        .insert(schema.loyaltyTransaction)
        .values(txRows.map((t) => ({ ...t, memberId: member.id })));

      for (const e of earnRows) {
        const [order] = await db
          .insert(schema.order)
          .values({
            externalId: e.bill,
            customerId,
            amount: e.amountMinor,
            currency,
            status: "PAID",
            items: [],
            metadata: {
              source: "qr.scan",
              memberId: member.id,
              basePoints: e.basePoints,
              delta: e.delta,
            },
            createdAt: e.createdAt,
          })
          .returning({ id: schema.order.id });
        totalBills++;

        await db.insert(schema.event).values({
          type: "loyalty.points.earned",
          entityId: member.id,
          createdAt: e.createdAt,
          payload: {
            memberId: member.id,
            customerId,
            programId: brand.programId,
            billNumber: e.bill,
            amountMinor: e.amountMinor,
            basePoints: e.basePoints,
            delta: e.delta,
            balance: balance,
            lifetimePoints: lifetime,
            tierId: currentTierId,
            earningRuleId: ruleId,
            orderId: order?.id ?? null,
            source: "qr.scan",
          },
        });
      }
    }
  }

  console.info(
    `\ndone — ${totalMembers} members, ${totalEarns} earns, ${totalRedeems} redeems, ` +
      `${totalBills} scan orders, ${totalPoints} points earned.`,
  );
  console.info("Open http://localhost:31000/reports and pick a brand.");
  await closeDb();
};

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
