import { implement } from "@orpc/server";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { schema } from "@offerkit/db";
import { contract } from "@offerkit/contract/router";
import type { RequestContext } from "@/server/context";
import { db } from "@/lib/db";
import { requireSession } from "@/server/middleware/auth";
import { decodeCursor, encodeCursor } from "./pagination";

const os = implement(contract).$context<RequestContext>();

const list = os.redemptions.list.use(requireSession).handler(async ({ input }) => {
  const filters: SQL[] = [];
  if (input.result) filters.push(eq(schema.redemption.result, input.result));
  if (input.campaignId) filters.push(eq(schema.voucher.campaignId, input.campaignId));
  if (input.voucherId) filters.push(eq(schema.redemption.voucherId, input.voucherId));
  if (input.search?.trim()) {
    const term = `%${input.search.trim()}%`;
    const matcher = or(
      ilike(schema.voucher.code, term),
      ilike(schema.customer.name, term),
      ilike(schema.customer.email, term),
    );
    if (matcher) filters.push(matcher);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) {
    filters.push(
      sql`(${schema.redemption.createdAt}, ${schema.redemption.id}) < (${cursor.createdAt}, ${cursor.id})`,
    );
  }

  const rows = await db()
    .select({
      id: schema.redemption.id,
      voucherId: schema.redemption.voucherId,
      voucherCode: schema.voucher.code,
      campaignId: schema.voucher.campaignId,
      currency: schema.campaign.currency,
      customerId: schema.redemption.customerId,
      customerName: schema.customer.name,
      customerEmail: schema.customer.email,
      result: schema.redemption.result,
      failureReason: schema.redemption.failureReason,
      amount: schema.redemption.amount,
      orderId: schema.redemption.orderId,
      externalOrderId: schema.redemption.externalOrderId,
      batchId: schema.redemption.batchId,
      idempotencyKey: schema.redemption.idempotencyKey,
      createdAt: schema.redemption.createdAt,
    })
    .from(schema.redemption)
    .innerJoin(schema.voucher, eq(schema.voucher.id, schema.redemption.voucherId))
    .leftJoin(schema.campaign, eq(schema.campaign.id, schema.voucher.campaignId))
    .leftJoin(schema.customer, eq(schema.customer.id, schema.redemption.customerId))
    .where(and(...filters))
    .orderBy(desc(schema.redemption.createdAt), desc(schema.redemption.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const data = rows.slice(0, input.limit);
  const last = data[data.length - 1];
  return {
    data: data.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    next:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : undefined,
  };
});

export const redemptionsRouter = { list };