# Agency setup & operations — running loyalty for multiple brands

**Audience:** the agency/operator who owns this OfferKit deployment and runs
loyalty programs on behalf of several client brands ("tenants").
**Read with:** `docs/multi-tenant-poc.md` (design), `docs/brand-operations.md`
(what you hand to each brand), `docs/multi-tenant-reporting.sql` (BI queries).

---

## 1. Can this stack do it? (short answer)

**Yes for the brand-facing loyalty surfaces; the operator dashboard is one
shared workspace, not a per-brand login.**

| Capability | Status | How |
|---|---|---|
| Run many brands' loyalty programs concurrently | ✅ | one `qr_brand` (name + program + PIN) per brand |
| Brands cannot see each other's data/operations | ✅ | every brand-facing call is gated by brand+PIN and scoped to one `loyalty_program.id` |
| Brands cannot enumerate each other | ✅ | `GET /api/brands` returns only `{ multiTenant: boolean }` |
| Operator (admin) sees and does everything | ✅ | dashboard + `/api/v1/**` are unscoped; `role=admin` |
| Each brand gets its own **dashboard login** limited to its data | ❌ not built | dashboard is a single workspace; no tenant column, no brand-scoped users, no RLS (see §6) |
| Per-brand isolation of vouchers / campaigns / orders / redemptions | ❌ not built | those resources are workspace-global, untagged by brand |

So: you operate all brands from **one admin dashboard**, and each brand gets an
**isolated terminal (`/scan`) and read-only self-serve report (`/reports`)**
guarded by their own PIN. Brands do **not** get dashboard accounts today.

---

## 2. Mental model

- A **brand** = a `qr_brand` row: `name` + `programId` + hashed `pin` (+
  `active`). It is a *terminal identity* for one loyalty program.
- A **loyalty program** = an `LOYALTY_PROGRAM` campaign + earning rules + tiers
  + rewards. Brand isolation is implemented by scoping brand-facing reads/writes
  to a single `programId`.
- A **customer** (`customer` row) is **global and shared**. The same person can
  be a member of several brands at once (`loyalty_member` rows differ per
  `programId`). A brand only ever *sees* its own members through `/reports`.
- **Roles:** `user.role` is only `admin` or `member`. `member` can already see
  all workspace data in the dashboard — there is no brand scoping on users.

### Where isolation is enforced

| Surface | Route / page | Gate | Scope |
|---|---|---|---|
| Merchant terminal (earn/redeem) | `POST /api/scan`, `POST /api/redeem`, `GET /api/rewards`, page `/scan` | `X-Brand` + `X-Brand-Pin` (`authorizeScan`) | brand's `programId` |
| Brand self-serve reporting | `GET /api/reports`, `/api/reports/customers`, `/api/reports/customer`, page `/reports` | same brand+PIN (`resolveReportScope`) | brand's `programId` |
| Customer card | `/card/[code]` | opaque bearer card code | card's own program |
| Brand existence probe | `GET /api/brands` | none | boolean only |

**Not isolated (shared workspace):** the dashboard, `GET /api/v1/**`, vouchers,
campaigns, segments, validation rules, orders, redemptions, events, webhooks,
insights, API keys, audit log. All admin/`member` users and all API keys see
every brand's data here.

---

## 3. One-time agency setup

### 3.1 Prerequisites

- Deployed OfferKit (Postgres + worker + web) per the repo README; DB migrations
  auto-run on web boot.
- An admin account (`admin@example.com` on a fresh dev seed) — sign in and change
  the forced temporary password.
- Optional: a **separate** workspace for the agency itself vs. a client? Today
  there is only one workspace per deployment (`workspace_setting` is a
  singleton). To hard-isolate two *agencies*, use **two deployments** (two DBs).

### 3.2 Create one loyalty program per brand

For each brand, in the dashboard:

1. **Campaigns → New** → type **LOYALTY_PROGRAM** (one program per campaign).
   Note its `programId` (the program row, not the campaign id) — you need it in
   step 3.3.
2. Configure the **earning rule** (e.g. `per_cents`, divisor 1000 = ₹10 → 1 pt),
   **tiers** (thresholds + basis-point multipliers), and **rewards** for that
   program. Amounts are in **minor units** (paise/cents).

> Naming tip: prefix brand objects (`ACME — Program`, `ACME — Reward: Free
> delivery`) so the shared dashboard stays readable. There is no brand grouping
> in the UI yet.

### 3.3 Register the brand (creates the terminal identity)

**Settings → Brands** (`/settings/brands`, admin only) → **New brand**:

- **Name** — what the brand types at the terminal (case-insensitive, unique).
- **Program** — the loyalty program from 3.2.
- **PIN** — min 4 chars, stored **hashed**; pick something the client can rotate
  (handled in §4).

Equivalent API (admin session):

```bash
# list (admin cookie/API key with admin role)
GET    /api/admin/brands                 # → { ok, brands:[…], legacyEnvConfigured }
POST   /api/admin/brands                 # { name, programId, pin } → 201 { brand }
PATCH  /api/admin/brands/{id}            # { name?, programId?, pin?, active? }
DELETE /api/admin/brands/{id}            # soft delete → 204
```

### 3.4 Verify

1. Open `/scan`, enter the brand **name + PIN**, earn a test bill
   (`card code or phone` + `amount` + unique `billNumber`) → 200 with new balance.
2. Open `/reports` with the same name+PIN → the test customer/bill appears.
3. Confirm isolation: a second brand cannot see the first brand's numbers, and a
   card from brand A scanned at brand B returns `403 wrong_brand`.

### 3.5 Legacy fallback (avoid unless migrating)

`MULTI_TENANT_BRANDS` (JSON map, `.env.example:48`) is only used when `qr_brand`
has **no active rows**. If you have DB brands, the env map is ignored. Leave it
unset once you're on DB brands. When it *is* the only config and it's empty, the
deployment runs in **legacy single-brand mode** (no PIN gate).

---

## 4. Day-to-day agency operations

### Brand lifecycle

| Task | Where |
|---|---|
| Onboard a brand | §3.2–3.4 |
| Rename brand / reassign its program | Settings → Brands → edit |
| Rotate the brand PIN | Settings → Brands → set new PIN; tell the client |
| Pause a brand (stop terminals) | set `active=false` (brand drops out of `loadBrands`) |
| Offboard (keep history) | Delete (soft; `deletedAt`) — rows and reports remain for the operator |

### Operator-wide monitoring (sees all brands)

- **Insights** (`/insights`) — redemption volume / top campaigns / failures.
- **Redemptions** (`/redemptions`) — workspace-wide ledger incl. failure reasons.
- **Orders** (`/orders`) and per-order redemptions.
- **Loyalty** (`/loyalty`) — every program, member, ledger.
- **Events** (`/events`) — `loyalty.points.earned` payloads carry `programId`,
  so you can filter by brand in the stream / webhooks.
- **Audit log** (`/settings/audit-log`, admin) — who changed what.
- **BI / SQL** — `docs/multi-tenant-reporting.sql` groups
  `loyalty_transaction`→`loyalty_member.program_id` for per-brand KPIs.

### Automation

- Contract → OpenAPI → SDK/MCP update automatically; the full `/api/v1/**`
  surface is available to agencies (e.g. `redemptions.list` for cross-brand
  reconciliations — SDK: `ovx().redemptions.list`, MCP tool `redemptions_list`).
- **⚠️ API keys are workspace-scoped and unscoped by brand** (scopes like
  `loyalty:read/write/redeem` derive from the path only). A key you mint for your
  own automation can read/write **all** brands — never hand a brand an API key
  and expect isolation. Brands use the PIN-gated public pages instead.

### Per-brand terminal naming

In brand mode the POS bill number is namespaced `{brand}:{bill}` before the
engine's global idempotency check (`event_id = qr:{bill}`, mirrored
`order.external_id`). So the same bill number at two brands is two independent
credits. Tell brands not to reuse bill numbers within their own brand.

---

## 5. Onboarding checklist (per client brand)

- [ ] Loyalty program + earning rule + tiers + rewards created (3.2)
- [ ] `qr_brand` row created with a fresh PIN; `active=true` (3.3)
- [ ] Brand name + PIN handed over out-of-band (never email the PIN in plaintext)
- [ ] Client terminal bookmarked to `/scan`; report bookmarked to `/reports`
- [ ] Smoke test: earn + redeem + report read (3.4)
- [ ] Client contact for PIN rotation

---

## 6. Gaps & roadmap (what to build if you need more)

Today's isolation is **app-enforced at the brand-facing surfaces only**. The
dashboard/API is deliberately one shared operator workspace
(`docs/multi-tenant-poc.md` §10 lists this as a non-goal). To add **per-brand
dashboard logins / full data-plane isolation**, you'd need:

1. **Tag resources with a brand/tenant.** Add `brandId` (or workspace) to
   vouchers, campaigns, orders, redemptions, etc., or introduce a real `tenant`
   table and FK everything to it.
2. **Brand-scoped users.** A `user ↔ brand` membership (or `brandId` on `user`)
   plus a third role (e.g. `brand_admin`) and a scope filter in every list router
   (`requireSession` currently returns no brand context).
3. **Enforce it server-side, ideally in the DB.** App-level `WHERE brand_id = …`
   is easy to miss; **Postgres Row-Level Security** keyed on a per-request
   `SET LOCAL` tenant, or per-brand read-only DB **views + roles**
   (`docs/multi-tenant-reporting.sql` §7), is the robust option.
4. **Per-brand API keys** (a `brandId` on `api_key`, enforced like an API-key
   scope) if you want brand automation isolated.
5. **Multi-currency / multi-timezone per brand** — currently workspace-level.

Until then, treat **brand isolation as guaranteed only on `/scan`, `/reports`,
and `/card/[code]`**, and keep the dashboard for agency staff only.
