# Multi-Tenant QR Loyalty — plan (Option 2)

**Branch:** `feature/multi_tenant`
**Goal:** let one OfferKit deployment serve **multiple brands** at the scan
terminal without changing any engine code (no `packages/core`, `packages/db`,
`packages/contract`, no upstream-owned routers).
**Hard constraint:** the only files we edit are our own POC additions
(`apps/web/src/server/qr-loyalty/*`, `/scan` and `/card/[code]` pages, tests,
config) — zero files that exist in upstream OfferKit.

## 1. Why this works

Brand identity already exists in the data, tagged by `loyalty_program.id`:

- every `loyalty_member` row has `program_id` → brand = program
- `loyalty.points.earned` events carry `programId` in the payload
- scan-created orders embed `memberId` in `metadata` (→ join to program)

The engine's scan flow is only brand-agnostic in three places, all fixable at
our layer because we already route every public call through
`apps/web/src/server/qr-loyalty/scan.ts`:

| engine behaviour (untouched) | our adapter fixes it by |
|---|---|
| `getMemberByCardCode` / `getMemberByPhone` are global | gate on `member.programId` before crediting (reject with `wrong_brand`) |
| `resolveDefaultQrProgram` picks newest program instance-wide | inject the brand's configured `programId` for quick-enroll; global default only used in legacy mode |
| `/api/scan` has no auth | `authorizeScan()` becomes a real per-brand shared-PIN guard |

## 2. Brand config (no DB, no engine)

New file `apps/web/src/server/qr-loyalty/brands.ts`:

- Read config from one env var at **request time** (so tests can toggle it):
  `MULTI_TENANT_BRANDS` = JSON map
  `{"brandA":{"programId":"<uuid>","pin":"1234"},"brandB":{"programId":"<uuid>","pin":"5678"}}`
- Export:
  - `BrandContext { brand: string; programId: string }`
  - `parseBrands(env)` → map (invalid JSON / empty → `{}` = legacy mode)
  - `getBrandContext(request)` → `{ brand, programId, authorized: boolean }`
- `MULTI_TENANT_BRANDS` unset or `{}` ⇒ **legacy single-brand mode** (today's
  behaviour, no guard). This is the migration path and keeps all existing e2e
  green.
- Document vars in `.env.example` (no code change to env loading).

## 3. Guard: `authorize.ts` (only call site is `handleScan`)

- `authorizeScan(request)` reads `X-Brand` + `X-Brand-Pin` headers.
- If `MULTI_TENANT_BRANDS` is empty ⇒ pass (legacy).
- Else: brand must exist and PIN must match ⇒ `BrandContext`, otherwise throw a
  `Response` with 401 (`invalid_brand` / `invalid_pin`).
- Constant-time PIN comparison (`crypto.timingSafeEqual` on hashed strings).
- Returns the `BrandContext` down to `handleScan` (signature change is internal
  to our adapter; no engine touch).

## 4. Adapter: `scan.ts` changes

1. After `authorizeScan`, have `BrandContext`.
2. **Cards are brand-locked, phones are brand-scoped.** In brand mode:
   - `cardCode` → resolve via `getMemberByCardCode`; if a member exists and
     `member.programId !== brand.programId` → `403 { code: "wrong_brand" }`
     (a card is a bearer token of one brand).
   - `phone` → resolve the member **within this brand's program**
     (`findBrandMemberByPhone`, a brand-scoped join). If the phone has a
     membership there, credit it. If not, quick-enroll into the brand's
     program on the fly — reusing the shared `customer` row when the phone is
     already known (auto-enroll with the stored name), otherwise 404
     `member_not_found` so `/scan` prompts for a name. A shopper can hold
     memberships in several brands at once.
3. **Quick-enroll:** uses `brand.programId` when brand context present (body
   `programId` ignored in brand mode). Legacy uses `resolveDefaultQrProgram`.
4. **Per-brand bill namespacing:** prefix the bill number with the brand
   (`{brand}:{bill}`) before calling `scanEarn` in brand mode. The engine keys
   idempotency on `event_id = qr:{bill}` and mirrors `order.external_id = {bill}`,
   both globally unique — without the prefix the same POS bill number at two
   brands would collide (409 `bill_already_processed`). So `BRAND A:TEST-123` and
   `BRAND B:TEST-123` are two separate credits; legacy passes the bill unchanged.
5. Legacy mode (no brand context) keeps today's exact path.

No change to `scanEarn` or any core function — we only gate before calling.

## 5. Terminal UI: `/scan` page

- Add a brand selector (dropdown) + shared-PIN field at the top; sent as
  `X-Brand` / `X-Brand-Pin` headers on `POST /api/scan`.
- PIN remembered in `sessionStorage` per brand for the shift.
- When `MULTI_TENANT_BRANDS` is empty the first brand option is "Single brand"
  and no PIN is required (legacy UI unchanged).

## 6. Card page `/card/[code]` — unchanged (accepted risk)

Codes are opaque bearer secrets and globally unique; a card only redeems in its
own brand's program because of step 4.2. Optionally later: `?brand=` query
check on the card URL if we want to hide foreign cards — explicitly deferred.

## 7. Tests (new file, our e2e harness)

`apps/web/src/server/router/flows/qr-scan-multitenant.e2e.test.ts` reusing
`getTestDb` / `makeClient` from `_helpers`:

- config parses valid JSON, tolerates bad JSON (→ legacy), requires uuid + pin
- legacy mode (env `{}`): existing scan behaviour unchanged with no headers
- brand mode: valid brand+pin ⇒ 200 credit; wrong pin ⇒ 401; unknown brand ⇒ 401
- wrong-brand card: card of brand A rejected at brand B terminal ⇒ 403
- cross-brand phone: phone already a member of A, scanned at B ⇒ 200, auto-enrolls
  into B and credits B's membership (same customer holds memberships in both)
- same-brand phone repeat: scan at the phone's own brand credits the existing
  membership (no re-enroll)
- brand-new phone without a name ⇒ 404 `member_not_found` (UI prompts quick-enroll)
- same bill number at two brands ⇒ two separate credits (event id + order external id namespaced per brand)
- quick-enroll with brand context enrolls into the BRAND's program (assert
  member `programId` + credit lands in that program's ledger)
- headerless request in brand mode ⇒ 401
- idempotency/race suite still passes unchanged (legacy path)

Brand context reads env at request time so tests set/restore
`process.env.MULTI_TENANT_BRANDS` per case.

## 8. Reporting companion

Engine cannot filter admin/API lists by brand (no contract param). Report on
top of the shared DB instead — no engine change:

- **Brand self-serve page (built):** **`/reports`** — a public, **read-only**
  page where a brand enters the **same brand + PIN** as `/scan`; it calls
  `GET /api/reports` (guarded by `authorizeScan()`, scoped to `ctx.programId`,
  so a brand sees only its own program) and renders KPI cards (customers,
  members, points earned/spent/outstanding, bills, revenue) plus tables for
  30-day daily activity and recent scans. Adapter:
  `apps/web/src/server/qr-loyalty/reports.ts` (`getBrandReport`) — pure reads,
  no engine change. Legacy mode falls back to `resolveDefaultQrProgram`.
  - **Customer level (built):** the same page also has a searchable
    **Customers** table (`GET /api/reports/customers?search=` →
    `getBrandCustomers`) listing every member of the brand with tier, balance,
    lifetime, bills and revenue; clicking a row opens that customer's detail
    (`GET /api/reports/customer?memberId=` → `getBrandCustomerReport`): profile,
    tier + next tier, points/revenue KPIs, the full **points ledger** and **scan
    history**. Both routes use the same PIN gate and are scoped to
    `ctx.programId`; a member belonging to another brand returns 404
    `member_not_found`, so a brand can never read another brand's customer.
  - **Tier timeline (derived):** there is no tier-history table — only
    `loyalty_member.current_tier_id` (current value) and a ledger with no tier
    column. So the customer detail reconstructs a **tier timeline**: each ledger
    entry is labelled with the tier just after it (`lifetimeAfter`,
    `tierName`, `previousTierName`, `tierChanged`), by replaying the ledger
    against the *current* ladder, anchored to the member's current
    `lifetimePoints`. Promotions are highlighted in the UI. Caveat: it uses
    today's thresholds, so editing the ladder retroactively changes the timeline;
    and it's approximate for ROLLBACK-of-adjustment (rare). For a durable record,
    emit a `loyalty.tier.changed` event in `earn()` (engine change, out of scope).
  - **Demo data:** `pnpm --filter @offerkit/web seed-reporting-demo [--per-brand=7]
    [--yes]` (`apps/web/scripts/seed-reporting-demo.mts`) seeds realistic,
    engine-consistent per-brand activity (tiers applied, ~26 days backdated) into
    all report tables; idempotent (only touches its own `demo-seed:%` rows).
- **BI read-only access** (Metabase/Superset/DuckDB) on the OfferKit Postgres,
  joining `loyalty_transaction`/`order` → `loyalty_member.program_id`, or
  `event.payload->>'programId'`. Full, ready-to-run queries (per-brand KPI
  summary, daily activity, top customers, recent scans, isolation views) live in
  **`docs/multi-tenant-reporting.sql`** (the `/reports` page mirrors these).
- **or webhook collector:** subscribe once to `loyalty.points.earned` (payload
  already has `programId`), fan aggregates into per-brand tables.
- Note: no row-level security in OfferKit — a read-only role **filters** by
  `program_id` but cannot *enforce* brand isolation. To give a brand client only
  their numbers, expose a per-brand **view** and grant just that view
  (`docs/multi-tenant-reporting.sql` §7), or hand them the `/reports` page
  (which enforces program scoping server-side).

```sql
-- per-brand points + scans (minimal summary; see docs/multi-tenant-reporting.sql)
select m.program_id as brand,
       coalesce(sum(t.delta) filter (where t.reason = 'EARN'), 0) as points_earned,
       coalesce(sum(-t.delta) filter (where t.delta < 0), 0)      as points_spent,
       count(*)                                                    as ledger_rows
from loyalty_transaction t
join loyalty_member m on m.id = t.member_id
group by 1;
```

> `loyalty_transaction` has a `reason` column (EARN/REDEEM/ADJUSTMENT/EXPIRY/
> ROLLBACK) and **no** `type` or soft-delete column; `order` has no `program_id`
> — join through `(order.metadata->>'memberId')::uuid`.

## 9. Deliverables / acceptance criteria

- [x] `feature/multi_tenant` branch, all changes limited to our POC files
- [x] `brands.ts` config parsed from `MULTI_TENANT_BRANDS`, legacy when unset
- [x] `authorizeScan` enforces per-brand PIN (constant-time), legacy passes
- [x] `scan.ts` cards brand-locked (403 `wrong_brand`), phones brand-scoped with cross-brand auto-enroll into the brand's program
- [x] `/scan` UI: brand + PIN fields; legacy mode identical to today
- [x] `/reports` read-only brand report page + `GET /api/reports` (same PIN gate), program-scoped
- [x] Customer-level report: `/reports` searchable customer table + `GET /api/reports/customers` and `GET /api/reports/customer?memberId=` (same PIN gate, program-scoped)
- [x] Derived tier timeline on each ledger entry (no engine change; `tierName`/`tierChanged` reconstructed from lifetime)
- [x] New e2e suite (7+ cases) green; existing qr-scan (21) + orders (2) + loyalty suites green
- [ ] `pnpm -r typecheck && pnpm -r lint` clean
- [x] `.env.example` documents `MULTI_TENANT_BRANDS`
- [x] AGENTS.md updated with the multi-tenant section + "no engine changes" rule
- [x] Reporting companion documented (doc only, out of this branch's code scope)

## 10. Explicit non-goals (this branch)

- No changes to `packages/core`, `packages/db`, `packages/contract`, or any
  upstream-owned router/file.
- No per-brand order/event filtering in the admin dashboard.
- No row-level security / per-brand DB roles.
- No card page brand restriction.

## 11. Task handoff contracts (single-track execution)

Execution is **strictly serial** — one task finishes and is verified before the
next starts. The producer of each boundary must satisfy EXACTLY these shapes so
the consumer receives unambiguous input. Do not change a signature without
updating this section.

**boundary 1 → 2,3 (brands.ts is consumed by authorize.ts and scan.ts)**

```ts
// apps/web/src/server/qr-loyalty/brands.ts
export interface BrandConfig { programId: string; pin: string }
export interface BrandContext { brand: string; programId: string }

// Reads process.env.MULTI_TENANT_BRANDS (JSON map). Empty/undefined/invalid
// JSON/malformed entries ⇒ `{}` (legacy mode). programId must be a uuid;
// pin must be a non-empty string. Read at CALL time (tests toggle env).
export function parseBrands(env?: string): Readonly<Record<string, BrandConfig>>

// Trimmed X-Brand header value, or null when absent/blank.
export function brandFromHeader(request: Request): string | null

// Keys of the map, sorted. Used only by GET /api/brands.
export function listBrandNames(brands: Readonly<Record<string, BrandConfig>>): string[]
```

**boundary 2 → 3 (authorize's return feeds scan.ts)**

```ts
// apps/web/src/server/qr-loyalty/authorize.ts
// - parseBrands() empty ⇒ legacy ⇒ return null (today's open behaviour).
// - brand absent or unknown ⇒ throw Response 401 { code: "unknown_brand" }.
// - X-Brand-Pin wrong ⇒ throw Response 401 { code: "invalid_pin" }.
// - ok ⇒ { brand, programId }.
export async function authorizeScan(request: Request): Promise<BrandContext | null>
```

**boundary 3 → 4,5 (scan.ts behaviour is what pages + e2e assert against)**

- `handleScan` gets `const ctx = await authorizeScan(request)`.
- Brand mode (`ctx` non-null):
  - `cardCode`: member present and `member.programId !== ctx.programId`
    ⇒ `403 { ok:false, code:"wrong_brand", message }` BEFORE calling `scanEarn`.
  - `phone`: credit the phone's membership in `ctx.programId` only; if it has no
    membership there, enroll it into `ctx.programId` (404 `member_not_found` if a
    brand-new customer and no name). The response includes `cardCode` and
    `enrolled: true` when the phone was enrolled for that brand.
  - quick-enroll/phone lookup uses `ctx.programId` (body `programId` is ignored in brand mode).
  - `billNumber` is prefixed with the brand (`{brand}:{bill}`) before `scanEarn`,
    so the same POS bill number at two brands is two separate credits.
- Legacy (`ctx` null): byte-for-byte today's path.

**boundary 4 → 5 (page consumes the API contract)**

- `GET /api/brands` ⇒ `200 { brands: string[] }` (empty list in legacy mode).
- `POST /api/scan` accepts headers `X-Brand`, `X-Brand-Pin`; new error codes
  `unknown_brand`/`invalid_pin` on 401, `wrong_brand` on 403.

**boundary 5 (e2e expectations)**

- e2e toggles `process.env.MULTI_TENANT_BRANDS` per case (helper restores
  after). Existing `qr-scan` (21) + `orders` (2) suites must stay green with
  the config empty (legacy default).