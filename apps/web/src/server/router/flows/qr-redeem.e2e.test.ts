import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import { handleListRewards, handleRedeem } from "@/server/qr-loyalty/redeem";
import {
  E2E_ENABLED,
  deleteTestKey,
  getTestDb,
  mintTestKey,
  randomId,
} from "./_helpers";
import { withMultitenantEnv } from "./test-helpers/multitenant";

// Distinct program ids per file: the test Db handle is shared across the whole
// test process (fileParallelism: false), so fixed ids would collide with the
// other QR suites.
const PID_A = crypto.randomUUID();
const PID_B = crypto.randomUUID();
const PIN_A = "1234";
const PIN_B = "5678";

const JSON_BRANDS = JSON.stringify({
  RABrand: { programId: PID_A, pin: PIN_A },
  RBBrand: { programId: PID_B, pin: PIN_B },
});

const HEADERS_A = { "x-brand": "RABrand", "x-brand-pin": PIN_A };
const HEADERS_B = { "x-brand": "RBBrand", "x-brand-pin": PIN_B };

let db: Db | undefined;
let prefix: string | undefined;

beforeAll(async () => {
  if (!E2E_ENABLED) return;
  ({ db } = await getTestDb());
  const { prefix: mintedPrefix } = await mintTestKey(db);
  prefix = mintedPrefix;
}, 30_000);

afterAll(async () => {
  if (db && prefix) await deleteTestKey(db, prefix);
});

function requireDb(): Db {
  if (!db) throw new Error("test db not initialised");
  return db;
}

function redeemRequest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleRedeem(
    new Request("http://test.local/api/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function rewardsRequest(headers: Record<string, string> = {}): Promise<Response> {
  return handleListRewards(new Request("http://test.local/api/rewards", { headers }));
}

/** Seed a LOYALTY_PROGRAM campaign + program. */
async function insertProgram(database: Db, programId: string): Promise<void> {
  const [campaign] = await database
    .insert(schema.campaign)
    .values({ name: randomId("rd-camp"), type: "LOYALTY_PROGRAM", currency: "INR" })
    .returning({ id: schema.campaign.id });
  if (!campaign) throw new Error("campaign insert failed");
  await database.insert(schema.loyaltyProgram).values({ id: programId, campaignId: campaign.id });
}

/** Seed a customer + loyalty member with an optional balance and card code. */
async function insertMember(
  database: Db,
  args: { programId: string; phone: string; cardCode?: string; balance?: number },
): Promise<{ customerId: string; memberId: string }> {
  const [customer] = await database
    .insert(schema.customer)
    .values({ name: "Redeem Customer", phone: args.phone })
    .returning({ id: schema.customer.id });
  if (!customer) throw new Error("customer insert failed");

  const [member] = await database
    .insert(schema.loyaltyMember)
    .values({
      customerId: customer.id,
      programId: args.programId,
      balance: args.balance ?? 0,
      ...(args.cardCode ? { cardCode: args.cardCode } : {}),
    })
    .returning({ id: schema.loyaltyMember.id });
  if (!member) throw new Error("member insert failed");

  return { customerId: customer.id, memberId: member.id };
}

/** Seed a reward (`cost` points → the given payload). */
async function insertReward(
  database: Db,
  args: { programId: string; name: string; cost: number },
): Promise<string> {
  const [row] = await database
    .insert(schema.loyaltyReward)
    .values({
      programId: args.programId,
      name: args.name,
      cost: args.cost,
      payload: { kind: "discount", discount: { type: "AMOUNT", amount: 10000 } },
    })
    .returning({ id: schema.loyaltyReward.id });
  if (!row) throw new Error("reward insert failed");
  return row.id;
}

describe.skipIf(!E2E_ENABLED)("qr redeem: spend points on a reward", () => {
  beforeAll(async () => {
    const database = requireDb();
    await insertProgram(database, PID_A);
    await insertProgram(database, PID_B);
  }, 30_000);

  it("legacy mode (env unset) redeems by card code and debits the balance", async () => {
    const database = requireDb();
    await withMultitenantEnv(undefined, async () => {
      const { memberId } = await insertMember(database, {
        programId: PID_A,
        phone: "9210000001",
        cardCode: "REDLEG01",
        balance: 500,
      });
      const rewardId = await insertReward(database, {
        programId: PID_A,
        name: "₹100 off",
        cost: 200,
      });

      const res = await redeemRequest({ cardCode: "REDLEG01", rewardId });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.cost).toBe(200);
      expect(body.balance).toBe(300);
      expect(body.payload.kind).toBe("discount");

      const [member] = await database
        .select({ balance: schema.loyaltyMember.balance })
        .from(schema.loyaltyMember)
        .where(eq(schema.loyaltyMember.id, memberId))
        .limit(1);
      expect(member?.balance).toBe(300);

      const redeemRows = await database
        .select({ reason: schema.loyaltyTransaction.reason, delta: schema.loyaltyTransaction.delta })
        .from(schema.loyaltyTransaction)
        .where(
          and(
            eq(schema.loyaltyTransaction.memberId, memberId),
            eq(schema.loyaltyTransaction.reason, "REDEEM"),
          ),
        );
      expect(redeemRows).toEqual([{ reason: "REDEEM", delta: -200 }]);
    });
  });

  it("brand mode: valid brand + pin redeems the brand's member", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, {
        programId: PID_A,
        phone: "9210000002",
        cardCode: "REDBRND1",
        balance: 400,
      });
      const rewardId = await insertReward(database, {
        programId: PID_A,
        name: "Brand A reward",
        cost: 100,
      });

      const res = await redeemRequest(
        { cardCode: "REDBRND1", rewardId },
        HEADERS_A,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.balance).toBe(300);
    });
  });

  it("brand mode: missing headers → 401 unknown_brand", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await redeemRequest({ cardCode: "REDBRND1", rewardId: crypto.randomUUID() });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("unknown_brand");
    });
  });

  it("brand mode: wrong PIN → 401 invalid_pin", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await redeemRequest(
        { cardCode: "REDBRND1", rewardId: crypto.randomUUID() },
        { "x-brand": "RABrand", "x-brand-pin": "0000" },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("invalid_pin");
    });
  });

  it("brand mode: brand A card at brand B → 403 wrong_brand", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, {
        programId: PID_A,
        phone: "9210000003",
        cardCode: "REDWRNGB",
        balance: 500,
      });
      const rewardId = await insertReward(database, {
        programId: PID_B,
        name: "Brand B reward",
        cost: 100,
      });
      const res = await redeemRequest({ cardCode: "REDWRNGB", rewardId }, HEADERS_B);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("wrong_brand");
    });
  });

  it("insufficient points → 422 and the balance is untouched", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, {
        programId: PID_A,
        phone: "9210000004",
        cardCode: "REDPOOR1",
        balance: 50,
      });
      const rewardId = await insertReward(database, {
        programId: PID_A,
        name: "Too expensive",
        cost: 999,
      });
      const res = await redeemRequest({ cardCode: "REDPOOR1", rewardId }, HEADERS_A);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("insufficient_points");
    });
  });

  it("unknown reward → 404 reward_not_found", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, {
        programId: PID_A,
        phone: "9210000005",
        cardCode: "REDNORE1",
        balance: 500,
      });
      const res = await redeemRequest(
        { cardCode: "REDNORE1", rewardId: crypto.randomUUID() },
        HEADERS_A,
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("reward_not_found");
    });
  });

  it("a reward from another program can't be redeemed → 404 reward_not_found", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, {
        programId: PID_A,
        phone: "9210000006",
        cardCode: "REDXB01",
        balance: 500,
      });
      const otherReward = await insertReward(database, {
        programId: PID_B,
        name: "Other program reward",
        cost: 100,
      });
      const res = await redeemRequest({ cardCode: "REDXB01", rewardId: otherReward }, HEADERS_A);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("reward_not_found");
    });
  });

  it("brand mode: redeems by brand-scoped phone", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const { memberId } = await insertMember(database, {
        programId: PID_A,
        phone: "9210000007",
        cardCode: "REDPHON1",
        balance: 400,
      });
      const rewardId = await insertReward(database, {
        programId: PID_A,
        name: "Phone reward",
        cost: 150,
      });
      const res = await redeemRequest({ phone: "9210000007", rewardId }, HEADERS_A);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.balance).toBe(250);
      expect(body.cardCode).toBe("REDPHON1");

      const [member] = await database
        .select({ balance: schema.loyaltyMember.balance })
        .from(schema.loyaltyMember)
        .where(eq(schema.loyaltyMember.id, memberId))
        .limit(1);
      expect(member?.balance).toBe(250);
    });
  });

  it("brand mode: unknown phone → 404 member_not_found (never enrolls)", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const rewardId = await insertReward(database, {
        programId: PID_A,
        name: "Unused reward",
        cost: 100,
      });
      const res = await redeemRequest({ phone: "9219999999", rewardId }, HEADERS_A);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("member_not_found");
    });
  });

  it("GET /api/rewards returns only the terminal's brand rewards", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertReward(database, { programId: PID_A, name: "A cheap", cost: 100 });
      await insertReward(database, { programId: PID_A, name: "A pricey", cost: 900 });
      await insertReward(database, { programId: PID_B, name: "B only", cost: 50 });

      const res = await rewardsRequest(HEADERS_A);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.programId).toBe(PID_A);
      const names = (body.rewards as { name: string }[]).map((r) => r.name);
      expect(names).toContain("A cheap");
      expect(names).toContain("A pricey");
      expect(names).not.toContain("B only");
      // Cheapest first.
      expect(names[0]).toBe("A cheap");
    });
  });

  it("GET /api/rewards rejects a bad PIN with 401", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await rewardsRequest({ "x-brand": "RABrand", "x-brand-pin": "nope" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("invalid_pin");
    });
  });
});
