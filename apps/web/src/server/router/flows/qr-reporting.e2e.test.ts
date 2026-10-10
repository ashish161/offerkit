import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@offerkit/db";
import { handleScan } from "@/server/qr-loyalty/scan";
import { getBrandCustomers, getBrandCustomerReport, getBrandReport } from "@/server/qr-loyalty/reports";
import { GET as getReport } from "@/app/api/reports/route";
import { GET as getCustomers } from "@/app/api/reports/customers/route";
import { GET as getCustomer } from "@/app/api/reports/customer/route";
import { E2E_ENABLED, getTestDb, randomId } from "./_helpers";
import { withMultitenantEnv } from "./test-helpers/multitenant";

const PID_A = "33333333-3333-4333-8333-333333333333";
const PID_B = "44444444-4444-4444-8444-444444444444";
const PIN_A = "1234";
const PIN_B = "5678";

const JSON_BRANDS = JSON.stringify({
  BrandA: { programId: PID_A, pin: PIN_A },
  BrandB: { programId: PID_B, pin: PIN_B },
});
const HEADERS_A = { "x-brand": "BrandA", "x-brand-pin": PIN_A };

let db: Db | undefined;

beforeAll(async () => {
  if (!E2E_ENABLED) return;
  ({ db } = await getTestDb());
}, 30_000);

afterAll(() => {
  db = undefined;
});

function requireDb(): Db {
  if (!db) throw new Error("test db not initialised");
  return db;
}

async function insertProgram(database: Db, programId: string): Promise<void> {
  const [campaign] = await database
    .insert(schema.campaign)
    .values({ name: randomId("rpt-camp"), type: "LOYALTY_PROGRAM", currency: "INR" })
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

async function insertMember(
  database: Db,
  args: { programId: string; phone: string; cardCode: string },
): Promise<string> {
  const [customer] = await database
    .insert(schema.customer)
    .values({ name: "RPT Customer", phone: args.phone })
    .returning({ id: schema.customer.id });
  if (!customer) throw new Error("customer insert failed");
  const [member] = await database
    .insert(schema.loyaltyMember)
    .values({
      customerId: customer.id,
      programId: args.programId,
      cardCode: args.cardCode,
    })
    .returning({ id: schema.loyaltyMember.id });
  if (!member) throw new Error("member insert failed");
  return member.id;
}

function scanRequest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleScan(
    new Request("http://test.local/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(!E2E_ENABLED)("qr reporting: per-brand report", () => {
  let seq = 0;
  const nextBill = () => `rpt-bill-${Date.now()}-${++seq}`;
  let memberA = "";
  let memberB = "";

  beforeAll(async () => {
    const database = requireDb();
    await insertProgram(database, PID_A);
    await insertProgram(database, PID_B);

    await withMultitenantEnv(JSON_BRANDS, async () => {
      memberA = await insertMember(database, {
        programId: PID_A,
        phone: "9220000001",
        cardCode: "RPTACARD",
      });
      memberB = await insertMember(database, {
        programId: PID_B,
        phone: "9220000002",
        cardCode: "RPTBCARD",
      });

      // Brand A: ₹100 + ₹200 → 300 pts, 2 bills, ₹300 revenue.
      await scanRequest({ cardCode: "RPTACARD", amount: 100, billNumber: nextBill() }, HEADERS_A);
      await scanRequest({ cardCode: "RPTACARD", amount: 200, billNumber: nextBill() }, HEADERS_A);
      // Brand B: ₹100 → 100 pts, 1 bill.
      await scanRequest(
        { cardCode: "RPTBCARD", amount: 100, billNumber: nextBill() },
        { "x-brand": "BrandB", "x-brand-pin": PIN_B },
      );
    });
  }, 30_000);

  it("scopes the summary to a single brand's program", async () => {
    const report = await getBrandReport(requireDb(), PID_A);
    expect(report.programId).toBe(PID_A);
    expect(report.summary.members).toBe(1);
    expect(report.summary.customers).toBe(1);
    expect(report.summary.pointsEarned).toBe(300);
    expect(report.summary.pointsOutstanding).toBe(300);
    expect(report.summary.bills).toBe(2);
    expect(report.summary.revenueMinor).toBe(30_000); // ₹100 + ₹200
  });

  it("does not leak another brand's members, bills or scans", async () => {
    const a = await getBrandReport(requireDb(), PID_A);
    expect(a.recentScans).toHaveLength(2);
    expect(a.recentScans.every((s) => s.bill?.startsWith("BrandA:"))).toBe(true);
    expect(a.topCustomers).toHaveLength(1);
    expect(a.topCustomers[0]?.pointsEarned).toBe(300);

    const b = await getBrandReport(requireDb(), PID_B);
    expect(b.summary.members).toBe(1);
    expect(b.summary.bills).toBe(1);
    expect(b.summary.revenueMinor).toBe(10_000); // ₹100
    expect(b.recentScans.every((s) => s.bill?.startsWith("BrandB:"))).toBe(true);
  });

  it("GET /api/reports: missing headers → 401 unknown_brand", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getReport(new Request("http://test.local/api/reports"));
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("unknown_brand");
    });
  });

  it("GET /api/reports: wrong PIN → 401 invalid_pin", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getReport(
        new Request("http://test.local/api/reports", {
          headers: { "x-brand": "BrandA", "x-brand-pin": "0000" },
        }),
      );
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("invalid_pin");
    });
  });

  it("GET /api/reports: valid brand + PIN returns that brand's report", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getReport(
        new Request("http://test.local/api/reports", { headers: HEADERS_A }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.report.programId).toBe(PID_A);
      expect(body.report.summary.bills).toBe(2);
    });
  });

  it("lists customers with their points, spend and recency, scoped to the brand", async () => {
    const a = await getBrandCustomers(requireDb(), PID_A);
    expect(a).toHaveLength(1);
    expect(a[0]?.memberId).toBe(memberA);
    expect(a[0]?.pointsEarned).toBe(300);
    expect(a[0]?.lifetimePoints).toBe(300);
    expect(a[0]?.balance).toBe(300);
    expect(a[0]?.bills).toBe(2);
    expect(a[0]?.revenueMinor).toBe(30_000);

    const b = await getBrandCustomers(requireDb(), PID_B);
    expect(b).toHaveLength(1);
    expect(b[0]?.memberId).toBe(memberB);
    // Brand A's customer never appears in Brand B's list.
    expect(b.some((c) => c.memberId === memberA)).toBe(false);
  });

  it("searches customers by name or phone", async () => {
    const byPhone = await getBrandCustomers(requireDb(), PID_A, { search: "92200000" });
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0]?.memberId).toBe(memberA);

    const miss = await getBrandCustomers(requireDb(), PID_A, { search: "no-such-customer" });
    expect(miss).toHaveLength(0);
  });

  it("returns a customer's profile, ledger and scans", async () => {
    const report = await getBrandCustomerReport(requireDb(), PID_A, memberA);
    expect(report).not.toBeNull();
    expect(report?.balance).toBe(300);
    expect(report?.lifetimePoints).toBe(300);
    expect(report?.pointsEarned).toBe(300);
    expect(report?.bills).toBe(2);
    expect(report?.revenueMinor).toBe(30_000);
    expect(report?.ledger).toHaveLength(2);
    expect(report?.scans).toHaveLength(2);
    expect(report?.scans.every((s) => s.bill?.startsWith("BrandA:"))).toBe(true);
  });

  it("never returns a customer that belongs to another brand", async () => {
    const leaked = await getBrandCustomerReport(requireDb(), PID_B, memberA);
    expect(leaked).toBeNull();
  });

  it("GET /api/reports/customers: valid brand returns only its customers", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getCustomers(
        new Request("http://test.local/api/reports/customers", { headers: HEADERS_A }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.customers).toHaveLength(1);
      expect(body.customers[0].memberId).toBe(memberA);
    });
  });

  it("GET /api/reports/customers: missing headers → 401", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getCustomers(new Request("http://test.local/api/reports/customers"));
      expect(res.status).toBe(401);
    });
  });

  it("GET /api/reports/customer: rejects a non-UUID memberId → 400", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getCustomer(
        new Request("http://test.local/api/reports/customer?memberId=nope", { headers: HEADERS_A }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("validation_error");
    });
  });

  it("GET /api/reports/customer: another brand's member → 404 member_not_found", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getCustomer(
        new Request(`http://test.local/api/reports/customer?memberId=${memberA}`, {
          headers: { "x-brand": "BrandB", "x-brand-pin": PIN_B },
        }),
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("member_not_found");
    });
  });

  it("GET /api/reports/customer: valid brand + member returns the detail", async () => {
    await withMultitenantEnv(JSON_BRANDS, async () => {
      const res = await getCustomer(
        new Request(`http://test.local/api/reports/customer?memberId=${memberA}`, {
          headers: HEADERS_A,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.report.memberId).toBe(memberA);
      expect(body.report.bills).toBe(2);
      expect(body.report.ledger).toHaveLength(2);
    });
  });
});
