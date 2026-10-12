import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@offerkit/db";
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

describe.skipIf(!E2E_ENABLED)("redemptions ledger", () => {
  it("lists success + failure rows with filters, search and cursor pagination", async () => {
    if (!token) throw new Error("setup failed");
    const client = makeClient(token);

    const campaign = await client.campaigns.create({
      name: randomId("camp-redemptions"),
      type: "DISCOUNT",
      currency: "USD",
    });
    await client.campaigns.update({
      params: { id: campaign.id },
      body: { patch: { status: "active" } },
    });
    const code = `RD${randomId("").replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const voucher = await client.vouchers.create({
      code,
      campaignId: campaign.id,
      type: "DISCOUNT",
      discount: { type: "AMOUNT", amount: 1_000 },
      redemptionLimit: 1,
    });

    const first = await client.vouchers.redeem({
      params: { code },
      body: {
        order: { amount: 5_000, currency: "USD" },
        idempotencyKey: randomId("idem"),
      },
    });
    expect(first.ok).toBe(true);
    const second = await client.vouchers.redeem({
      params: { code },
      body: {
        order: { amount: 5_000, currency: "USD" },
        idempotencyKey: randomId("idem"),
      },
    });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("redemption_limit_reached");

    // Both rows appear, newest first.
    const page = await client.redemptions.list({ limit: 10 });
    const byCode = page.data.filter((r) => r.voucherCode === code);
    expect(byCode.length).toBe(2);
    expect(byCode[0]?.result).toBe("FAILURE");
    expect(byCode[1]?.result).toBe("SUCCESS");
    expect(byCode[1]?.voucherId).toBe(voucher.id);
    expect(byCode[1]?.campaignId).toBe(campaign.id);
    expect(byCode[1]?.currency).toBe("USD");
    expect(byCode[1]?.amount).toBe(1_000);

    // Result filter.
    const failures = await client.redemptions.list({ result: "FAILURE", limit: 10 });
    expect(failures.data.every((r) => r.result === "FAILURE")).toBe(true);
    expect(failures.data.some((r) => r.voucherCode === code)).toBe(true);

    // Code search.
    const bySearch = await client.redemptions.list({ search: code, limit: 10 });
    expect(bySearch.data.every((r) => r.voucherCode === code)).toBe(true);
    expect(bySearch.data.length).toBe(2);

    // Voucher scoping.
    const scoped = await client.redemptions.list({ voucherId: voucher.id, limit: 10 });
    expect(scoped.data.length).toBe(2);

    // Cursor pagination: page 1 (1 row) → page 2 with the remaining row.
    const p1 = await client.redemptions.list({ search: code, limit: 1 });
    expect(p1.data.length).toBe(1);
    expect(p1.next).toBeDefined();
    const p2 = await client.redemptions.list({ search: code, limit: 1, cursor: p1.next });
    expect(p2.data.length).toBe(1);
    expect(p2.data[0]?.id).not.toBe(p1.data[0]?.id);
  });
});