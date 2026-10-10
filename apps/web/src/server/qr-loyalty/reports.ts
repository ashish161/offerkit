import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@offerkit/db";

/**
 * Per-brand loyalty reporting for the read-only brand report page.
 *
 * Brand identity == loyalty_program.id. Every query is scoped to a single
 * `programId`, so a brand only ever sees its own numbers (no engine change,
 * no schema change — pure reads over the shared tables). Mirrors
 * `docs/multi-tenant-reporting.sql`.
 */

export interface BrandReportSummary {
  customers: number;
  members: number;
  pointsEarned: number;
  pointsSpent: number;
  pointsOutstanding: number;
  bills: number;
  revenueMinor: number;
}

export interface BrandReportDailyRow {
  day: string;
  earnEvents: number;
  pointsEarned: number;
  pointsSpent: number;
}

export interface BrandReportTopCustomer {
  customerId: string;
  name: string | null;
  phone: string | null;
  lifetimePoints: number;
  balance: number;
  pointsEarned: number;
}

export interface BrandReportScan {
  bill: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface BrandReport {
  programId: string;
  /** Campaign/brand name, or null if the program no longer exists. */
  brand: string | null;
  currency: string | null;
  summary: BrandReportSummary;
  /** Last 30 days of ledger activity, newest first. */
  daily: BrandReportDailyRow[];
  topCustomers: BrandReportTopCustomer[];
  recentScans: BrandReportScan[];
}

export interface BrandCustomerRow {
  memberId: string;
  customerId: string;
  name: string | null;
  phone: string | null;
  balance: number;
  lifetimePoints: number;
  tierName: string | null;
  pointsEarned: number;
  pointsSpent: number;
  bills: number;
  revenueMinor: number;
  lastActivityAt: string;
}

export interface BrandCustomerLedgerRow {
  id: string;
  reason: string;
  delta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export interface BrandCustomerScan {
  bill: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface BrandCustomerReport {
  memberId: string;
  customerId: string;
  name: string | null;
  phone: string | null;
  cardCode: string | null;
  balance: number;
  lifetimePoints: number;
  tierName: string | null;
  nextTierName: string | null;
  nextTierThreshold: number | null;
  enrolledAt: string;
  pointsEarned: number;
  pointsSpent: number;
  bills: number;
  revenueMinor: number;
  ledger: BrandCustomerLedgerRow[];
  scans: BrandCustomerScan[];
}

const EMPTY_SUMMARY: BrandReportSummary = {
  customers: 0,
  members: 0,
  pointsEarned: 0,
  pointsSpent: 0,
  pointsOutstanding: 0,
  bills: 0,
  revenueMinor: 0,
};

/** Run a raw statement and return its rows (works for both pg and PGlite). */
async function query<T>(database: Db, statement: SQL): Promise<T[]> {
  const result = await database.execute(statement);
  return (result as unknown as { rows: T[] }).rows;
}

export async function getBrandReport(database: Db, programId: string): Promise<BrandReport> {
  const id = sql`${programId}::uuid`;

  const brandRows = await query<{ name: string; currency: string }>(
    database,
    sql`select ca.name, ca.currency
        from loyalty_program p
        join campaign ca on ca.id = p.campaign_id
        where p.id = ${id}
        limit 1`,
  );
  const brand = brandRows[0] ?? null;

  const summaryRows = await query<{
    customers: number;
    members: number;
    points_outstanding: number;
    points_earned: number;
    points_spent: number;
    bills: number;
    revenue_minor: number;
  }>(
    database,
    sql`select
        (select count(distinct customer_id) from loyalty_member where program_id = ${id})::int as customers,
        (select count(*) from loyalty_member where program_id = ${id})::int as members,
        (select coalesce(sum(balance), 0) from loyalty_member where program_id = ${id})::int as points_outstanding,
        (select coalesce(sum(t.delta) filter (where t.delta > 0), 0)
           from loyalty_transaction t
           join loyalty_member m on m.id = t.member_id
          where m.program_id = ${id})::int as points_earned,
        (select coalesce(sum(-t.delta) filter (where t.delta < 0), 0)
           from loyalty_transaction t
           join loyalty_member m on m.id = t.member_id
          where m.program_id = ${id})::int as points_spent,
        (select count(*)
           from "order" o
           join loyalty_member m on m.id = (o.metadata->>'memberId')::uuid
          where m.program_id = ${id} and o.metadata->>'source' = 'qr.scan')::int as bills,
        (select coalesce(sum(o.amount), 0)
           from "order" o
           join loyalty_member m on m.id = (o.metadata->>'memberId')::uuid
          where m.program_id = ${id} and o.metadata->>'source' = 'qr.scan')::int as revenue_minor`,
  );
  const s = summaryRows[0];

  const dailyRows = await query<{
    day: string;
    earn_events: number;
    points_earned: number;
    points_spent: number;
  }>(
    database,
    sql`select date_trunc('day', t.created_at)::date as day,
               count(*) filter (where t.reason = 'EARN')::int as earn_events,
               coalesce(sum(t.delta) filter (where t.delta > 0), 0)::int as points_earned,
               coalesce(sum(-t.delta) filter (where t.delta < 0), 0)::int as points_spent
        from loyalty_transaction t
        join loyalty_member m on m.id = t.member_id
        where m.program_id = ${id} and t.created_at >= now() - interval '30 days'
        group by 1
        order by 1 desc`,
  );

  const topRows = await query<{
    customer_id: string;
    name: string | null;
    phone: string | null;
    lifetime_points: number;
    balance: number;
    points_earned: number;
  }>(
    database,
    sql`select cu.id as customer_id, cu.name, cu.phone,
               m.lifetime_points, m.balance,
               coalesce(sum(t.delta) filter (where t.delta > 0), 0)::int as points_earned
        from loyalty_member m
        join customer cu on cu.id = m.customer_id
        left join loyalty_transaction t on t.member_id = m.id
        where m.program_id = ${id} and cu.deleted_at is null
        group by cu.id, cu.name, cu.phone, m.lifetime_points, m.balance
        order by points_earned desc
        limit 20`,
  );

  const scanRows = await query<{
    bill: string | null;
    amount_minor: number;
    currency: string;
    status: string;
    created_at: string;
  }>(
    database,
    sql`select o.external_id as bill, o.amount as amount_minor, o.currency, o.status, o.created_at
        from "order" o
        join loyalty_member m on m.id = (o.metadata->>'memberId')::uuid
        where m.program_id = ${id} and o.metadata->>'source' = 'qr.scan'
        order by o.created_at desc
        limit 50`,
  );

  return {
    programId,
    brand: brand?.name ?? null,
    currency: brand?.currency ?? null,
    summary: s
      ? {
          customers: Number(s.customers),
          members: Number(s.members),
          pointsEarned: Number(s.points_earned),
          pointsSpent: Number(s.points_spent),
          pointsOutstanding: Number(s.points_outstanding),
          bills: Number(s.bills),
          revenueMinor: Number(s.revenue_minor),
        }
      : { ...EMPTY_SUMMARY },
    daily: dailyRows.map((r) => ({
      day: String(r.day),
      earnEvents: Number(r.earn_events),
      pointsEarned: Number(r.points_earned),
      pointsSpent: Number(r.points_spent),
    })),
    topCustomers: topRows.map((r) => ({
      customerId: r.customer_id,
      name: r.name,
      phone: r.phone,
      lifetimePoints: Number(r.lifetime_points),
      balance: Number(r.balance),
      pointsEarned: Number(r.points_earned),
    })),
    recentScans: scanRows.map((r) => ({
      bill: r.bill,
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

/**
 * Customer-level list for a brand's program: every member with their points,
 * tier, spend and recency. Optional case-insensitive search over name/phone.
 * Scoped to `programId`, so a brand only ever sees its own customers.
 */
export async function getBrandCustomers(
  database: Db,
  programId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<BrandCustomerRow[]> {
  const id = sql`${programId}::uuid`;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const search = opts.search?.trim();
  const searchFilter = search
    ? sql`and (cu.name ilike ${`%${search}%`} or cu.phone ilike ${`%${search}%`})`
    : sql``;

  const rows = await query<{
    member_id: string;
    customer_id: string;
    name: string | null;
    phone: string | null;
    balance: number;
    lifetime_points: number;
    tier_name: string | null;
    points_earned: number;
    points_spent: number;
    bills: number;
    revenue_minor: number;
    last_activity_at: string;
  }>(
    database,
    sql`select m.id as member_id, cu.id as customer_id, cu.name, cu.phone,
               m.balance, m.lifetime_points, tier.name as tier_name,
               coalesce(led.points_earned, 0)::int as points_earned,
               coalesce(led.points_spent, 0)::int as points_spent,
               coalesce(bi.bills, 0)::int as bills,
               coalesce(bi.revenue_minor, 0)::int as revenue_minor,
               greatest(coalesce(led.last_tx, m.enrolled_at), coalesce(bi.last_order, m.enrolled_at)) as last_activity_at
        from loyalty_member m
        join customer cu on cu.id = m.customer_id
        left join loyalty_tier tier on tier.id = m.current_tier_id
        left join (
          select member_id,
                 sum(delta) filter (where delta > 0) as points_earned,
                 sum(-delta) filter (where delta < 0) as points_spent,
                 max(created_at) as last_tx
          from loyalty_transaction group by member_id
        ) led on led.member_id = m.id
        left join (
          select (metadata->>'memberId')::uuid as member_id,
                 count(*) as bills, sum(amount) as revenue_minor, max(created_at) as last_order
          from "order" where metadata->>'source' = 'qr.scan' group by 1
        ) bi on bi.member_id = m.id
        where m.program_id = ${id} and cu.deleted_at is null ${searchFilter}
        order by m.lifetime_points desc
        limit ${limit}`,
  );

  return rows.map((r) => ({
    memberId: r.member_id,
    customerId: r.customer_id,
    name: r.name,
    phone: r.phone,
    balance: Number(r.balance),
    lifetimePoints: Number(r.lifetime_points),
    tierName: r.tier_name,
    pointsEarned: Number(r.points_earned),
    pointsSpent: Number(r.points_spent),
    bills: Number(r.bills),
    revenueMinor: Number(r.revenue_minor),
    lastActivityAt: new Date(r.last_activity_at).toISOString(),
  }));
}

/**
 * Full customer-level report for one membership within a brand's program:
 * profile + tier + points + revenue, the points ledger, and scan history.
 * Returns null when the member is not part of `programId` (so a brand can never
 * read another brand's customer).
 */
export async function getBrandCustomerReport(
  database: Db,
  programId: string,
  memberId: string,
): Promise<BrandCustomerReport | null> {
  const id = sql`${programId}::uuid`;
  const mid = sql`${memberId}::uuid`;

  const profileRows = await query<{
    member_id: string;
    customer_id: string;
    name: string | null;
    phone: string | null;
    card_code: string | null;
    balance: number;
    lifetime_points: number;
    tier_name: string | null;
    enrolled_at: string;
  }>(
    database,
    sql`select m.id as member_id, cu.id as customer_id, cu.name, cu.phone, m.card_code,
               m.balance, m.lifetime_points, tier.name as tier_name, m.enrolled_at
        from loyalty_member m
        join customer cu on cu.id = m.customer_id
        left join loyalty_tier tier on tier.id = m.current_tier_id
        where m.id = ${mid} and m.program_id = ${id}
        limit 1`,
  );
  const profile = profileRows[0];
  if (!profile) return null;

  const nextRows = await query<{ name: string; threshold: number }>(
    database,
    sql`select name, threshold from loyalty_tier
        where program_id = ${id} and threshold > ${Number(profile.lifetime_points)}
        order by threshold asc limit 1`,
  );

  const statRows = await query<{
    points_earned: number;
    points_spent: number;
    bills: number;
    revenue_minor: number;
  }>(
    database,
    sql`select
        (select coalesce(sum(delta) filter (where delta > 0), 0) from loyalty_transaction where member_id = ${mid})::int as points_earned,
        (select coalesce(sum(-delta) filter (where delta < 0), 0) from loyalty_transaction where member_id = ${mid})::int as points_spent,
        (select count(*) from "order" where metadata->>'memberId' = ${memberId} and metadata->>'source' = 'qr.scan')::int as bills,
        (select coalesce(sum(amount), 0) from "order" where metadata->>'memberId' = ${memberId} and metadata->>'source' = 'qr.scan')::int as revenue_minor`,
  );
  const stats = statRows[0];

  const ledgerRows = await query<{
    id: string;
    reason: string;
    delta: number;
    balance_after: number;
    note: string | null;
    created_at: string;
  }>(
    database,
    sql`select id, reason, delta, balance_after, note, created_at
        from loyalty_transaction
        where member_id = ${mid}
        order by created_at desc
        limit 100`,
  );

  const scanRows = await query<{
    bill: string | null;
    amount_minor: number;
    currency: string;
    status: string;
    created_at: string;
  }>(
    database,
    sql`select external_id as bill, amount as amount_minor, currency, status, created_at
        from "order"
        where metadata->>'memberId' = ${memberId} and metadata->>'source' = 'qr.scan'
        order by created_at desc
        limit 50`,
  );

  const next = nextRows[0] ?? null;

  return {
    memberId: profile.member_id,
    customerId: profile.customer_id,
    name: profile.name,
    phone: profile.phone,
    cardCode: profile.card_code,
    balance: Number(profile.balance),
    lifetimePoints: Number(profile.lifetime_points),
    tierName: profile.tier_name,
    nextTierName: next?.name ?? null,
    nextTierThreshold: next ? Number(next.threshold) : null,
    enrolledAt: new Date(profile.enrolled_at).toISOString(),
    pointsEarned: stats ? Number(stats.points_earned) : 0,
    pointsSpent: stats ? Number(stats.points_spent) : 0,
    bills: stats ? Number(stats.bills) : 0,
    revenueMinor: stats ? Number(stats.revenue_minor) : 0,
    ledger: ledgerRows.map((r) => ({
      id: r.id,
      reason: r.reason,
      delta: Number(r.delta),
      balanceAfter: Number(r.balance_after),
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    scans: scanRows.map((r) => ({
      bill: r.bill,
      amountMinor: Number(r.amount_minor),
      currency: r.currency,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}
