import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
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
  let programId: string;
  let seq = 0;
  const nextBill = () => `${prefix}-b${++seq}`;

  beforeAll(async () => {
    if (!token || !db) throw new Error("setup failed");
    const client = makeClient(token);

    const campaign = await client.campaigns.create({
      name: randomId("camp-qr"),
      type: "LOYALTY_PROGRAM",
      currency: "INR",
    });
    const program = await client.loyalty.programs.create({ campaignId: campaign.id });
    programId = program.id;
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
    const res = await scanRequest({ cardCode, amount: 2500, billNumber: nextBill() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(250); // ₹2,500 → 250 pts at ₹10/pt
    expect(body.delta).toBe(250); // no tier multiplier (no tiers)
    expect(body.balance).toBe(250);
    expect(body.alreadyCredited).toBe(false);
  });

  it("emits a loyalty.points.earned event and mirrors a PAID order", async () => {
    if (!db) throw new Error("no db");
    const billNumber = nextBill();
    const res = await scanRequest({ cardCode, amount: 1000, billNumber });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.orderId).toBe("string");

    const order = await db.query.order.findFirst({
      where: eq(schema.order.externalId, billNumber),
    });
    expect(order).toBeTruthy();
    expect(order?.status).toBe("PAID");
    expect(order?.amount).toBe(100_000); // ₹1,000 → 100000 paise
    expect(order?.currency).toBe("INR");
    expect(order?.metadata["source"]).toBe("qr.scan");
    expect(body.orderId).toBe(order?.id);

    const ev = await db.query.event.findFirst({
      where: eq(schema.event.entityId, memberId),
      orderBy: [desc(schema.event.createdAt)],
    });
    expect(ev).toBeTruthy();
    expect(ev?.type).toBe("loyalty.points.earned");
    expect(ev?.payload["billNumber"]).toBe(billNumber);
    expect(ev?.payload["delta"]).toBe(body.delta);
    expect(ev?.payload["memberId"]).toBe(memberId);
    expect(ev?.payload["orderId"]).toBe(order?.id);
  });

  it("lowercases/whitespace card codes are accepted", async () => {
    const res = await scanRequest({
      cardCode: ` ${cardCode.toLowerCase()} `,
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(10); // ₹100 → 10 pts
  });

  it("is idempotent for the same bill number (no double credit)", async () => {
    const billNumber = nextBill();
    const first = await scanRequest({ cardCode, amount: 500, billNumber });
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.ok).toBe(true);

    const second = await scanRequest({ cardCode, amount: 500, billNumber });
    const secondBody = await second.json();
    expect(second.status).toBe(409); // processed bill → conflict
    expect(secondBody.ok).toBe(true);
    expect(secondBody.alreadyCredited).toBe(true);
    expect(secondBody.balance).toBe(firstBody.balance); // unchanged
  });

  it("rejects a bill number already processed for another member", async () => {
    const billNumber = nextBill();
    const first = await scanRequest({ phone: "9777000011", name: "Nina", amount: 200, billNumber });
    expect(first.status).toBe(200);

    const cross = await scanRequest({ cardCode, amount: 200, billNumber });
    expect(cross.status).toBe(409);
    const body = await cross.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("bill_already_processed");
  });

  it("unknown card code → 404 member_not_found", async () => {
    const res = await scanRequest({
      cardCode: "ZZZZ9999",
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("member_not_found");
  });

  it("resolves a member by phone alias (formatting-insensitive)", async () => {
    const res = await scanRequest({ phone: "+91 90964 44567", amount: 1000, billNumber: nextBill() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(100); // ₹1,000 → 100 pts
  });

  it("unknown phone → 404 with a phone-specific message", async () => {
    const res = await scanRequest({ phone: "9000000000", amount: 100, billNumber: nextBill() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("member_not_found");
    expect(body.message).toMatch(/phone/i);
  });

  it("quick-enrolls a new customer from a bare phone and credits points", async () => {
    const res = await scanRequest({
      phone: "9888000001",
      name: "Priya",
      amount: 1000,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enrolled).toBe(true);
    expect(body.memberId).toBeDefined();
    expect(body.cardCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.basePoints).toBe(100); // ₹1,000 → 100 pts at ₹10/pt
  });

  it("resolves the quick-enrolled member on their next scan (no duplicate customer)", async () => {
    const res = await scanRequest({ phone: "9888000001", amount: 100, billNumber: nextBill() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enrolled).toBeUndefined(); // existing member, not enrolled again
  });

  it("supports explicit programId for quick-enroll", async () => {
    const res = await scanRequest({
      phone: "9888000002",
      name: "Ravi",
      programId,
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enrolled).toBe(true);
  });

  it("quick-enroll persists the customer name and email", async () => {
    if (!db) throw new Error("setup failed");
    const res = await scanRequest({
      phone: "9888000004",
      name: "Meera",
      email: "meera@example.com",
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(true);

    const { schema } = await import("@offerkit/db");
    const { eq } = await import("drizzle-orm");
    const [member] = await db
      .select({ customerId: schema.loyaltyMember.customerId })
      .from(schema.loyaltyMember)
      .where(eq(schema.loyaltyMember.id, body.memberId))
      .limit(1);
    if (!member) throw new Error("member not found");
    const [customer] = await db
      .select({ name: schema.customer.name, email: schema.customer.email })
      .from(schema.customer)
      .where(eq(schema.customer.id, member.customerId))
      .limit(1);
    expect(customer?.name).toBe("Meera");
    expect(customer?.email).toBe("meera@example.com");
  });

  it("quick-enroll with unknown programId → failed gracefully", async () => {
    const res = await scanRequest({
      phone: "9888000003",
      name: "Nobody",
      programId: "00000000-0000-0000-0000-000000000000",
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("program_not_found");
  });

  it("card code takes precedence over a phone value in the same request", async () => {
    const res = await scanRequest({
      cardCode,
      phone: "9000000000",
      amount: 100,
      billNumber: nextBill(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("neither card code nor phone → 400 validation_error", async () => {
    const res = await scanRequest({ amount: 100, billNumber: nextBill() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("missing bill number → 400 validation_error", async () => {
    const res = await scanRequest({ cardCode, amount: 100 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("non-positive amount → 400 validation_error", async () => {
    const res = await scanRequest({ cardCode, amount: 0, billNumber: nextBill() });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("malformed body → 400", async () => {
    const res = await scanRequest({ cardCode: "!!!", billNumber: nextBill() });
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
    // 250 + 10 + 50 + 100 (phone) + 10 (card precedence) + 100 (event) = 520
    expect(mine?.balance).toBe(520);
  });
});
