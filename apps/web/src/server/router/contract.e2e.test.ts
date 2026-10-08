import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@offerkit/db";
import {
  E2E_ENABLED,
  deleteTestKey,
  getTestDb,
  makeClient,
  mintTestKey,
} from "./flows/_helpers";

// SDK contract end-to-end test. Drives the typed @offerkit/sdk client
// against the live oRPC router via a fake fetch. Enable with
// TEST_DATABASE_URL or OFFERKIT_TEST_PGLITE=1.

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

describe.skipIf(!E2E_ENABLED)("SDK contract e2e", () => {
  it("typed client mints a campaign + voucher and redeems it", async () => {
    if (!token) throw new Error("setup failed");

    const client = makeClient(token);

    const campaign = await client.campaigns.create({
      name: `e2e-${Date.now()}`,
      type: "DISCOUNT",
      currency: "USD",
    });
    await client.campaigns.update({
      params: { id: campaign.id },
      body: { patch: { status: "active" } },
    });
    expect(campaign.id).toMatch(/^[0-9a-f-]{36}$/);

    const bulk = await client.vouchers.bulk({
      campaignId: campaign.id,
      count: 1,
      discount: { type: "AMOUNT", amount: 500 },
    });
    expect(bulk.generated).toBe(1);

    const list = await client.vouchers.list({ campaignId: campaign.id, limit: 5 });
    const voucher = list.data[0];
    expect(voucher).toBeDefined();
    if (!voucher) return;

    const validated = await client.vouchers.validate({
      params: { code: voucher.code },
      body: { order: { amount: 5_000, currency: "USD" } },
    });
    expect(validated.valid).toBe(true);

    const redeemed = await client.vouchers.redeem({
      params: { code: voucher.code },
      body: { order: { amount: 5_000, currency: "USD" } },
    });
    expect(redeemed.ok).toBe(true);
    expect(redeemed.redemptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redeemed.amount).toBe(500);
  }, 30_000);
});
