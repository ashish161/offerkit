import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@offerkit/db";
import { ensureCardCode } from "@offerkit/core/loyalty";
import { handleScan } from "@/server/qr-loyalty/scan";
import {
  E2E_ENABLED,
  deleteTestKey,
  getTestDb,
  makeClient,
  mintTestKey,
  randomId,
} from "./_helpers";

let db: Db | undefined;
let token: string | undefined;
let prefix: string | undefined;

beforeAll(async () => {
  if (!E2E_ENABLED) return;
  ({ db } = await getTestDb());
  const minted = await mintTestKey(db);
  token = minted.token;
  prefix = minted.prefix;
}, 30_000);

afterAll(async () => {
  if (db && prefix) await deleteTestKey(db, prefix);
});

function scanRequest(body: unknown): Promise<Response> {
  return handleScan(
    new Request("http://test.local/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(!E2E_ENABLED)("qr scan: card code → bill amount → points", () => {
  let cardCode: string;
  let memberId: string;

  beforeAll(async () => {
    if (!token || !db) throw new Error("setup failed");
    const client = makeClient(token);

    const campaign = await client.campaigns.create({
      name: randomId("camp-qr"),
      type: "LOYALTY_PROGRAM",
      currency: "INR",
    });
    const program = await client.loyalty.programs.create({ campaignId: campaign.id });
    // ₹10 bill → 1 point (amountMinor / 1000)
    await client.loyalty.earningRules.create({
      programId: program.id,
      name: "₹10 per point",
      event: "qr.scan",
      formula: { kind: "per_cents", divisor: 1000 },
    });
    const customer = await client.customers.create({
      name: "Ashish",
      email: `${randomId("qrc")}@example.com`,
      phone: "9096444567",
    });
    const member = await client.loyalty.members.enroll({
      programId: program.id,
      customerId: customer.id,
    });
    memberId = member.id;
    cardCode = await ensureCardCode(db, memberId);
  }, 30_000);

  it("credits points from a bill amount using the program earning rule", async () => {
    const res = await scanRequest({ cardCode, amount: 2500 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(250); // ₹2,500 → 250 pts at ₹10/pt
    expect(body.delta).toBe(250); // no tier multiplier (no tiers)
    expect(body.balance).toBe(250);
    expect(body.alreadyCredited).toBe(false);
  });

  it("lowercases/whitespace card codes are accepted", async () => {
    const res = await scanRequest({ cardCode: ` ${cardCode.toLowerCase()} `, amount: 100 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(10); // ₹100 → 10 pts
  });

  it("is idempotent for the same eventId (no double credit)", async () => {
    const eventId = `scan-${randomId("evt")}`;
    const first = await scanRequest({ cardCode, amount: 500, eventId });
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);

    const second = await scanRequest({ cardCode, amount: 500, eventId });
    const secondBody = await second.json();
    expect(secondBody.ok).toBe(true);
    expect(secondBody.alreadyCredited).toBe(true);
    expect(secondBody.balance).toBe(firstBody.balance); // unchanged
  });

  it("unknown card code → 404 member_not_found", async () => {
    const res = await scanRequest({ cardCode: "ZZZZ9999", amount: 100 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("member_not_found");
  });

  it("resolves a member by phone alias (formatting-insensitive)", async () => {
    const res = await scanRequest({ phone: "+91 90964 44567", amount: 1000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(100); // ₹1,000 → 100 pts
  });

  it("unknown phone → 404 with a phone-specific message", async () => {
    const res = await scanRequest({ phone: "9000000000", amount: 100 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("member_not_found");
    expect(body.message).toMatch(/phone/i);
  });

  it("card code takes precedence over a phone value in the same request", async () => {
    const res = await scanRequest({ cardCode, phone: "9000000000", amount: 100 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("neither card code nor phone → 400 validation_error", async () => {
    const res = await scanRequest({ amount: 100 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("non-positive amount → 400 validation_error", async () => {
    const res = await scanRequest({ cardCode, amount: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("malformed body → 400", async () => {
    const res = await scanRequest({ cardCode: "!!!" });
    expect(res.status).toBe(400);
  });

  it("balance on the member row matches credited total", async () => {
    if (!db) throw new Error("setup failed");
    const { schema } = await import("@offerkit/db");
    const { eq } = await import("drizzle-orm");
    const [mine] = await db
      .select()
      .from(schema.loyaltyMember)
      .where(eq(schema.loyaltyMember.id, memberId))
      .limit(1);
    expect(mine).toBeDefined();
    expect(mine?.cardCode).toBe(cardCode);
    // 250 + 10 + 50 + 100 (phone) + 10 (card precedence) = 420
    expect(mine?.balance).toBe(420);
  });
});
