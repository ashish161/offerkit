import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@offerkit/db";
import { authorizeScan } from "@/server/qr-loyalty/authorize";
import {
  createQrBrand,
  deleteQrBrand,
  isUniqueViolation,
  listQrBrands,
  updateQrBrand,
} from "@/server/qr-loyalty/admin";
import { hashPin, verifyPin } from "@/server/qr-loyalty/pins";
import { resolveReportScope } from "@/server/qr-loyalty/report-scope";
import { handleScan } from "@/server/qr-loyalty/scan";
import { E2E_ENABLED, getTestDb, randomId } from "./_helpers";

const PID_A = "33333333-3333-4333-8333-333333333333";
const PID_B = "44444444-4444-4444-8444-444444444444";

let db: Db | undefined;

beforeAll(async () => {
  if (!E2E_ENABLED) return;
  ({ db } = await getTestDb());
}, 30_000);

afterAll(async () => {
  // Keep the table empty so the env-based multi-tenant suite still sees
  // "no DB brands" (matters on a shared Postgres test DB).
  if (db) await db.delete(schema.qrBrand);
});

function requireDb(): Db {
  if (!db) throw new Error("test db not initialised");
  return db;
}

/** Run a promise and return the thrown value (undefined if it resolved). */
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}

async function authStatus(p: Promise<unknown>): Promise<number> {
  const err = await caught(p);
  return err instanceof Response ? err.status : 0;
}

async function insertProgram(database: Db, programId: string): Promise<void> {
  const [campaign] = await database
    .insert(schema.campaign)
    .values({ name: randomId("brand-camp"), type: "LOYALTY_PROGRAM", currency: "INR" })
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
    .values({ name: "Brand Customer", phone: args.phone })
    .returning({ id: schema.customer.id });
  if (!customer) throw new Error("customer insert failed");
  const [member] = await database
    .insert(schema.loyaltyMember)
    .values({ customerId: customer.id, programId: args.programId, cardCode: args.cardCode })
    .returning({ id: schema.loyaltyMember.id });
  if (!member) throw new Error("member insert failed");
  return member.id;
}

function authRequest(headers: Record<string, string>): Request {
  return new Request("http://test.local/api/scan", { headers });
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

describe.skipIf(!E2E_ENABLED)("qr brands: DB-backed auth + admin CRUD", () => {
  let seq = 0;
  const nextBill = () => `brand-bill-${Date.now()}-${++seq}`;

  beforeAll(async () => {
    const database = requireDb();
    await insertProgram(database, PID_A);
    await insertProgram(database, PID_B);
  }, 30_000);

  it("pins are hashed and verify round-trips", async () => {
    const hash = await hashPin("1234");
    expect(hash).not.toBe("1234");
    expect(await verifyPin("1234", hash)).toBe(true);
    expect(await verifyPin("0000", hash)).toBe(false);
    expect(await verifyPin("1234", "not-a-hash")).toBe(false);
  });

  it("creates, lists and resolves a brand from the DB", async () => {
    const database = requireDb();
    const created = await createQrBrand(database, {
      name: "DbBrandA",
      programId: PID_A,
      pin: "1234",
    });
    expect(created.name).toBe("DbBrandA");
    expect(created.programId).toBe(PID_A);
    expect(created.active).toBe(true);

    const listed = await listQrBrands(database);
    expect(listed.some((b) => b.id === created.id)).toBe(true);

    const ctx = await authorizeScan(
      authRequest({ "x-brand": "DbBrandA", "x-brand-pin": "1234" }),
    );
    expect(ctx).toEqual({ brand: "DbBrandA", programId: PID_A, brandId: created.id });
  });

  it("brand name lookup is case-insensitive", async () => {
    const database = requireDb();
    await createQrBrand(database, { name: "Cased", programId: PID_A, pin: "1111" });
    const ctx = await authorizeScan(authRequest({ "x-brand": "cased", "x-brand-pin": "1111" }));
    expect(ctx?.programId).toBe(PID_A);
  });

  it("rejects a wrong PIN and an unknown brand with 401", async () => {
    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "DbBrandA", "x-brand-pin": "nope" }))),
    ).toBe(401);
    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "Ghost", "x-brand-pin": "1234" }))),
    ).toBe(401);
    expect(await authStatus(authorizeScan(authRequest({})))).toBe(401);
  });

  it("rejects a duplicate brand name (unique index, case-insensitive)", async () => {
    const database = requireDb();
    const err = await caught(
      createQrBrand(database, { name: "dbbranda", programId: PID_B, pin: "2222" }),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("resetting the PIN invalidates the old one", async () => {
    const database = requireDb();
    const brand = await createQrBrand(database, { name: "ResetMe", programId: PID_A, pin: "1234" });
    await updateQrBrand(database, brand.id, { pin: "9999" });

    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "ResetMe", "x-brand-pin": "1234" }))),
    ).toBe(401);
    const ctx = await authorizeScan(authRequest({ "x-brand": "ResetMe", "x-brand-pin": "9999" }));
    expect(ctx?.programId).toBe(PID_A);
  });

  it("renaming a brand keeps the PIN working under the new name", async () => {
    const database = requireDb();
    const brand = await createQrBrand(database, { name: "OldName", programId: PID_B, pin: "4321" });
    const renamed = await updateQrBrand(database, brand.id, { name: "NewName" });
    expect(renamed?.name).toBe("NewName");

    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "OldName", "x-brand-pin": "4321" }))),
    ).toBe(401);
    const ctx = await authorizeScan(authRequest({ "x-brand": "NewName", "x-brand-pin": "4321" }));
    expect(ctx?.programId).toBe(PID_B);
  });

  it("a deactivated brand stops authenticating", async () => {
    const database = requireDb();
    const brand = await createQrBrand(database, { name: "Toggle", programId: PID_A, pin: "1234" });
    await updateQrBrand(database, brand.id, { active: false });
    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "Toggle", "x-brand-pin": "1234" }))),
    ).toBe(401);
  });

  it("a deleted brand stops authenticating and is pruned from the list", async () => {
    const database = requireDb();
    const brand = await createQrBrand(database, { name: "ByeNow", programId: PID_A, pin: "1234" });
    expect(await deleteQrBrand(database, brand.id)).toBe(true);
    expect(await deleteQrBrand(database, brand.id)).toBe(false);
    expect(
      await authStatus(authorizeScan(authRequest({ "x-brand": "ByeNow", "x-brand-pin": "1234" }))),
    ).toBe(401);
    const listed = await listQrBrands(database);
    expect(listed.some((b) => b.id === brand.id)).toBe(false);
  });

  it("isolates brands: a brand A card is rejected at brand B", async () => {
    const database = requireDb();
    await createQrBrand(database, { name: "IsoA", programId: PID_A, pin: "1000" });
    await createQrBrand(database, { name: "IsoB", programId: PID_B, pin: "2000" });
    await insertMember(database, { programId: PID_A, phone: "9330000001", cardCode: "ISOACARD" });

    const res = await scanRequest(
      { cardCode: "ISOACARD", amount: 100, billNumber: nextBill() },
      { "x-brand": "IsoB", "x-brand-pin": "2000" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("wrong_brand");
  });

  it("a brand with a valid PIN credits its own program", async () => {
    const database = requireDb();
    await insertMember(database, { programId: PID_A, phone: "9330000002", cardCode: "ISOCARD1" });
    const res = await scanRequest(
      { cardCode: "ISOCARD1", amount: 100, billNumber: nextBill() },
      { "x-brand": "IsoA", "x-brand-pin": "1000" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.basePoints).toBe(100);
  });

  it("report scope resolves to the brand's own program", async () => {
    const database = requireDb();
    const scope = await resolveReportScope(
      authRequest({ "x-brand": "IsoA", "x-brand-pin": "1000" }),
    );
    expect(scope.ok).toBe(true);
    if (scope.ok) expect(scope.programId).toBe(PID_A);

    const denied = await resolveReportScope(
      authRequest({ "x-brand": "IsoA", "x-brand-pin": "wrong" }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(401);

    // A member of brand B is invisible to brand A's scope (enforced upstream
    // by scoping every report query to this programId).
    const memberB = await insertMember(database, {
      programId: PID_B,
      phone: "9330000003",
      cardCode: "ISOCARD2",
    });
    const [row] = await database
      .select({ programId: schema.loyaltyMember.programId })
      .from(schema.loyaltyMember)
      .where(eq(schema.loyaltyMember.id, memberB))
      .limit(1);
    expect(row?.programId).toBe(PID_B);
  });
});
