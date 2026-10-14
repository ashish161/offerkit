import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import { handleScan } from "@/server/qr-loyalty/scan";
import {
  E2E_ENABLED,
  deleteTestKey,
  getTestDb,
  mintTestKey,
  randomId,
} from "./_helpers";
import { withMultitenantEnv } from "./test-helpers/multitenant";

const PID_A = "11111111-1111-4111-8111-111111111111";
const PID_B = "22222222-2222-4222-8222-222222222222";
const PIN_A = "1234";
const PIN_B = "5678";

const JSON_BRANDS = JSON.stringify({
  BrandA: { programId: PID_A, pin: PIN_A },
  BrandB: { programId: PID_B, pin: PIN_B },
});

const HEADERS_A = { "x-brand": "BrandA", "x-brand-pin": PIN_A };
const HEADERS_B = { "x-brand": "BrandB", "x-brand-pin": PIN_B };

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

/** The shared handle, asserted present once the suite is enabled. */
function requireDb(): Db {
  if (!db) throw new Error("test db not initialised");
  return db;
}

/** POST /api/scan — a plain Request, mirroring the public route handler. */
function scanRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleScan(
    new Request("http://test.local/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Seed a LOYALTY_PROGRAM campaign + program + `qr.scan` earning rule. */
async function insertProgram(database: Db, programId: string): Promise<void> {
  const [campaign] = await database
    .insert(schema.campaign)
    .values({
      name: randomId("mt-camp"),
      type: "LOYALTY_PROGRAM",
      currency: "INR",
    })
    .returning({ id: schema.campaign.id });
  if (!campaign) throw new Error("campaign insert failed");

  await database.insert(schema.loyaltyProgram).values({ id: programId, campaignId: campaign.id });
  await database.insert(schema.loyaltyEarningRule).values({
    id: crypto.randomUUID(),
    programId,
    name: "qr.scan",
    event: "qr.scan",
    formula: { kind: "per_cents", divisor: 100 },
  });
}

/** Seed a customer + loyalty member (optionally with a card code). */
async function insertMember(
  database: Db,
  args: { programId: string; phone: string; cardCode?: string },
): Promise<{ customerId: string; memberId: string }> {
  const [customer] = await database
    .insert(schema.customer)
    .values({ name: "MT Customer", phone: args.phone })
    .returning({ id: schema.customer.id });
  if (!customer) throw new Error("customer insert failed");

  const [member] = await database
    .insert(schema.loyaltyMember)
    .values({
      customerId: customer.id,
      programId: args.programId,
      ...(args.cardCode ? { cardCode: args.cardCode } : {}),
    })
    .returning({ id: schema.loyaltyMember.id });
  if (!member) throw new Error("member insert failed");

  return { customerId: customer.id, memberId: member.id };
}

describe.skipIf(!E2E_ENABLED)("qr scan: multi-tenant brands", () => {
  let seq = 0;
  const nextBill = () => `mt-bill-${Date.now()}-${++seq}`;

  beforeAll(async () => {
    const database = requireDb();
    await insertProgram(database, PID_A);
    await insertProgram(database, PID_B);
  }, 30_000);

  it("legacy mode (env unset) credits without headers", async () => {
    const database = requireDb();
    await withMultitenantEnv(undefined, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000001", cardCode: "LEGCARD1" });
      const res = await scanRequest({ cardCode: "LEGCARD1", amount: 100, billNumber: nextBill() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.basePoints).toBe(100); // ₹100 → 100 pts at per_cents/100
    });
  });

  it("brand mode: valid brand + pin credits the brand's member", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000002", cardCode: "VALIDCRD" });
      const res = await scanRequest(
        { cardCode: "VALIDCRD", amount: 100, billNumber: nextBill() },
        HEADERS_A,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.basePoints).toBe(100);
    });
  });

  it("brand mode: missing X-Brand → 401 unknown_brand", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest({ cardCode: "NOPE1234", amount: 10, billNumber: nextBill() });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("unknown_brand");
    });
  });

  it("brand mode: unknown brand name → 401 unknown_brand", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest(
        { cardCode: "NOPE1234", amount: 10, billNumber: nextBill() },
        { "x-brand": "Ghost", "x-brand-pin": "9999" },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("unknown_brand");
    });
  });

  it("brand mode: wrong PIN → 401 invalid_pin", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest(
        { cardCode: "NOPE1234", amount: 10, billNumber: nextBill() },
        { "x-brand": "BrandA", "x-brand-pin": "0000" },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("invalid_pin");
    });
  });

  it("brand mode: missing PIN → 401 invalid_pin", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest(
        { cardCode: "NOPE1234", amount: 10, billNumber: nextBill() },
        { "x-brand": "BrandA" },
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("invalid_pin");
    });
  });

  it("brand mode: brand A card at brand B terminal → 403 wrong_brand", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000006", cardCode: "WRONGCAR" });
      const res = await scanRequest(
        { cardCode: "WRONGCAR", amount: 100, billNumber: nextBill() },
        HEADERS_B,
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("wrong_brand");
    });
  });

  it("brand mode: phone can hold memberships in multiple brands (cross-brand enroll)", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const { customerId } = await insertMember(database, {
        programId: PID_A,
        phone: "9110000007",
      });
      const res = await scanRequest(
        { phone: "9110000007", amount: 100, billNumber: nextBill() },
        HEADERS_B,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.enrolled).toBe(true);
      expect(body.cardCode).toBeTruthy();

      const memberships = await database
        .select({ programId: schema.loyaltyMember.programId })
        .from(schema.loyaltyMember)
        .where(eq(schema.loyaltyMember.customerId, customerId));
      expect(memberships.map((m) => m.programId).sort()).toEqual([PID_A, PID_B].sort());
    });
  });

  it("brand mode: repeat phone scan at the same brand credits the existing membership", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const { memberId } = await insertMember(database, {
        programId: PID_A,
        phone: "9110000011",
      });
      const res = await scanRequest(
        { phone: "9110000011", amount: 100, billNumber: nextBill() },
        HEADERS_A,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.memberId).toBe(memberId);
      expect(body.enrolled).toBeFalsy();
    });
  });

  it("brand mode: brand-new phone without a name → 404 member_not_found (prompts quick-enroll)", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest(
        { phone: "9110000012", amount: 100, billNumber: nextBill() },
        HEADERS_B,
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe("member_not_found");
    });
  });

  it("brand mode: the same bill number at two brands are separate credits", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000013", cardCode: "SAMEBILL" });
      await insertMember(database, { programId: PID_B, phone: "9110000014", cardCode: "SB2CARDS" });
      const bill = nextBill();

      const a = await scanRequest(
        { cardCode: "SAMEBILL", amount: 100, billNumber: bill },
        HEADERS_A,
      );
      expect(a.status).toBe(200);

      const b = await scanRequest(
        { cardCode: "SB2CARDS", amount: 100, billNumber: bill },
        HEADERS_B,
      );
      expect(b.status).toBe(200);
      const bBody = await b.json();
      expect(bBody.ok).toBe(true);
      expect(bBody.alreadyCredited).toBe(false);

      // Both brands mirrored their own order for the same POS bill number.
      const orders = await database
        .select({ externalId: schema.order.externalId })
        .from(schema.order)
        .where(eq(schema.order.externalId, `${HEADERS_B["x-brand"]}:${bill}`));
      expect(orders).toHaveLength(1);
    });
  });

  it("brand mode: quick-enrolls a new phone into the brand's program", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await scanRequest(
        { phone: "9110000008", name: "Newbie", amount: 100, billNumber: nextBill() },
        HEADERS_A,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.enrolled).toBe(true);

      const [member] = await database
        .select({ programId: schema.loyaltyMember.programId })
        .from(schema.loyaltyMember)
        .where(eq(schema.loyaltyMember.id, body.memberId))
        .limit(1);
      expect(member?.programId).toBe(PID_A);
    });
  });

  it("brand mode: headerless request is rejected before crediting", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000009", cardCode: "NOHEADER" });
      const res = await scanRequest({ cardCode: "NOHEADER", amount: 100, billNumber: nextBill() });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("unknown_brand");
    });
  });

  it("brand mode: replaying a bill returns 409 alreadyCredited", async () => {
    const database = requireDb();
    await withMultitenantEnv(JSON_BRANDS, async () => {
      await insertMember(database, { programId: PID_A, phone: "9110000010", cardCode: "REPLAYCR" });
      const billNumber = nextBill();
      const first = await scanRequest(
        { cardCode: "REPLAYCR", amount: 500, billNumber },
        HEADERS_A,
      );
      expect(first.status).toBe(200);

      const second = await scanRequest(
        { cardCode: "REPLAYCR", amount: 500, billNumber },
        HEADERS_A,
      );
      expect(second.status).toBe(409);
      const body = await second.json();
      expect(body.ok).toBe(true);
      expect(body.alreadyCredited).toBe(true);
    });
  });
});
