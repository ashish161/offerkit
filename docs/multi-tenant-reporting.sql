-- ============================================================================
-- Multi-tenant QR loyalty — per-brand reporting SQL
-- ----------------------------------------------------------------------------
-- Brand identity == loyalty_program.id ("program_id"). Every member, ledger
-- row and scan order links back to it, so per-brand reports are pure SQL on
-- the shared DB — no engine code, no dashboard change.
--
-- Join chain for anything order/scan related:
--   "order".metadata->>'memberId' (uuid)  ->  loyalty_member.id  ->  program_id
-- (works for both namespaced `{brand}:{bill}` and older un-prefixed orders)
--
-- Usage: run in psql (`docker exec -i offerkit-postgres-1 psql -U offerkit -d offerkit`)
-- or point a read-only BI role at these queries. Scope to one brand by adding
--   and <alias>.program_id = '<PROGRAM_UUID>'
-- to the WHERE clause (see the isolation views at the bottom).
--
-- Notes on the schema:
--   * loyalty_transaction.reason ∈ (EARN, REDEEM, ADJUSTMENT, EXPIRY, ROLLBACK)
--     — there is NO `type` column and NO soft-delete column.
--   * Soft-deleted rows: customer.deleted_at, campaign.deleted_at (filter them).
--   * Amounts are in minor units (paise): divide by 100 for display.
-- ============================================================================


-- 1) Per-brand KPI summary (one row per active loyalty program)
with brand as (
  select p.id as program_id, ca.name as brand_name, ca.currency
  from loyalty_program p
  join campaign ca on ca.id = p.campaign_id
  where ca.type = 'LOYALTY_PROGRAM' and ca.deleted_at is null
),
members as (
  select program_id,
         count(*)                    as members,
         count(distinct customer_id) as customers,
         coalesce(sum(balance), 0)   as points_outstanding
  from loyalty_member
  group by program_id
),
ledger as (
  select m.program_id,
         coalesce(sum(t.delta) filter (where t.delta > 0), 0)  as points_earned,
         coalesce(sum(-t.delta) filter (where t.delta < 0), 0) as points_spent,
         count(*) filter (where t.reason = 'EARN')             as earn_events
  from loyalty_transaction t
  join loyalty_member m on m.id = t.member_id
  group by m.program_id
),
bills as (
  select m.program_id,
         count(*)                   as bills,
         coalesce(sum(o.amount), 0) as revenue_minor
  from "order" o
  join loyalty_member m on m.id = (o.metadata->>'memberId')::uuid
  where o.metadata->>'source' = 'qr.scan'
  group by m.program_id
)
select b.brand_name,
       b.program_id,
       b.currency,
       coalesce(mem.customers, 0)          as customers,
       coalesce(mem.members, 0)            as members,
       coalesce(led.points_earned, 0)      as points_earned,
       coalesce(led.points_spent, 0)       as points_spent,
       coalesce(mem.points_outstanding, 0) as points_outstanding,
       coalesce(bi.bills, 0)               as bills,
       coalesce(bi.revenue_minor, 0)       as revenue_minor
from brand b
left join members mem on mem.program_id = b.program_id
left join ledger  led on led.program_id = b.program_id
left join bills   bi  on bi.program_id  = b.program_id
order by b.brand_name;


-- 2) Per-brand daily activity (points + bill volume by day)
select date_trunc('day', t.created_at)::date as day,
       ca.name                                as brand,
       count(*) filter (where t.reason = 'EARN')             as earn_events,
       coalesce(sum(t.delta)  filter (where t.delta > 0), 0) as points_earned,
       coalesce(sum(-t.delta) filter (where t.delta < 0), 0) as points_spent
from loyalty_transaction t
join loyalty_member  m  on m.id = t.member_id
join loyalty_program p  on p.id = m.program_id
join campaign        ca on ca.id = p.campaign_id
where ca.deleted_at is null
group by 1, 2
order by 1 desc, 2;


-- 3) Per-brand top customers (by lifetime points earned)
select ca.name as brand,
       cu.name as customer,
       cu.phone,
       m.lifetime_points,
       m.balance,
       coalesce(sum(t.delta) filter (where t.delta > 0), 0) as points_earned
from loyalty_member m
join customer        cu on cu.id = m.customer_id
join loyalty_program p  on p.id = m.program_id
join campaign        ca on ca.id = p.campaign_id
left join loyalty_transaction t on t.member_id = m.id
where cu.deleted_at is null and ca.deleted_at is null
group by ca.name, cu.name, cu.phone, m.lifetime_points, m.balance
order by points_earned desc
limit 20;


-- 4) Per-brand recent scans (mirrored orders)
select ca.name       as brand,
       o.external_id as bill,
       o.amount      as amount_minor,
       o.currency,
       o.status,
       o.created_at
from "order" o
join loyalty_member  m  on m.id = (o.metadata->>'memberId')::uuid
join loyalty_program p  on p.id = m.program_id
join campaign        ca on ca.id = p.campaign_id
where o.metadata->>'source' = 'qr.scan'
order by o.created_at desc
limit 50;


-- ============================================================================
-- 5) Brand isolation for a BI tool / brand client
-- ----------------------------------------------------------------------------
-- OfferKit has no row-level security, so a shared read-only role can *filter*
-- by program_id but cannot *enforce* it. To give a brand ONLY their numbers,
-- expose a per-brand view and grant just that view (views run with the owner's
-- privileges, so the grantee can't read the base tables).
-- ============================================================================

-- Shared read-only reporting login (internal analysts — sees all brands):
--   create role offerkit_report login password 'CHANGE_ME';
--   grant connect on database offerkit to offerkit_report;
--   grant usage on schema public to offerkit_report;
--   grant select on campaign, loyalty_program, loyalty_member,
--                   loyalty_transaction, customer, "order", event
--     to offerkit_report;

-- Per-brand view (repeat per brand; replace the uuid):
-- create or replace view report_brand_a as
--   select ca.name as brand, cu.phone,
--          m.lifetime_points, m.balance,
--          t.created_at, t.reason, t.delta, t.balance_after
--   from loyalty_member m
--   join customer        cu on cu.id = m.customer_id
--   join campaign        ca on ca.id = (select campaign_id from loyalty_program where id = m.program_id)
--   left join loyalty_transaction t on t.member_id = m.id
--   where m.program_id = '<BRAND_A_PROGRAM_UUID>';
--
-- create role brand_a_report login password 'CHANGE_ME';
-- grant usage on schema public to brand_a_report;
-- grant select on report_brand_a to brand_a_report;
