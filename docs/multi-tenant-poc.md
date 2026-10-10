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
2. **Cross-brand redemption gate:** if brand context present and the request
   has `cardCode`/`phone`, resolve the member first via exported core helpers
   `getMemberByCardCode` / `getMemberByPhone`; if a member exists and
   `member.programId !== brand.programId` → `403 { code: "wrong_brand" }`.
3. **Quick-enroll:** replace `resolveDefaultQrProgram(db())` at scan.ts:34 with
   `brand.programId` when brand context present. New phones for brand B can
   never enroll into brand A's program.
4. Legacy mode (no brand context) keeps today's exact path.

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
- wrong-brand phone: phone enrolled in A rejected at B ⇒ 403
- quick-enroll with brand context enrolls into the BRAND's program (assert
  member `programId` + credit lands in that program's ledger)
- headerless request in brand mode ⇒ 401
- idempotency/race suite still passes unchanged (legacy path)

Brand context reads env at request time so tests set/restore
`process.env.MULTI_TENANT_BRANDS` per case.

## 8. Reporting companion (separate from the code change)

Engine cannot filter admin/API lists by brand (no contract param). Report on
top of the shared DB instead — no engine change:

- **BI read-only access** (Metabase/Superset/DuckDB) on the OfferKit Postgres,
  joining `loyalty_transaction`/`order` → `loyalty_member.program_id`, or
  `event.payload->>'programId'`. Sample view below.
- **or webhook collector:** subscribe once to `loyalty.points.earned` (payload
  already has `programId`), fan aggregates into per-brand tables.
- Note: no row-level security in OfferKit — a read-only role **filters** by
  `program_id` but cannot *enforce* brand isolation. Fine for reports, not for
  giving brand clients direct DB access.

```sql
-- per-brand points + orders (BI view)
select m.program_id as brand,
       sum(t.delta) filter (where t.type = 'EARN')  as points_earned,
       sum(t.delta) filter (where t.type = 'BURN')  as points_burned,
       count(*)      filter (where o.id is not null) as bills
from loyalty_transaction t
join loyalty_member m on m.id = t.member_id
left join "order" o on o.id = (t.metadata->>'orderId')::uuid
where t.deleted_at is null
group by 1;
```

## 9. Deliverables / acceptance criteria

- [x] `feature/multi_tenant` branch, all changes limited to our POC files
- [x] `brands.ts` config parsed from `MULTI_TENANT_BRANDS`, legacy when unset
- [x] `authorizeScan` enforces per-brand PIN (constant-time), legacy passes
- [x] `scan.ts` gates wrong-brand members and enrolls new phones into brand's program
- [x] `/scan` UI: brand + PIN fields; legacy mode identical to today
- [ ] New e2e suite (7+ cases) green; existing qr-scan (21) + orders (2) + loyalty suites green
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
  - member present (cardCode/phone) and `member.programId !== ctx.programId`
    ⇒ `403 { ok:false, code:"wrong_brand", message }` BEFORE calling `scanEarn`.
  - quick-enroll uses `ctx.programId` (body `programId` is ignored in brand mode).
- Legacy (`ctx` null): byte-for-byte today's path.

**boundary 4 → 5 (page consumes the API contract)**

- `GET /api/brands` ⇒ `200 { brands: string[] }` (empty list in legacy mode).
- `POST /api/scan` accepts headers `X-Brand`, `X-Brand-Pin`; new error codes
  `unknown_brand`/`invalid_pin` on 401, `wrong_brand` on 403.

**boundary 5 (e2e expectations)**

- e2e toggles `process.env.MULTI_TENANT_BRANDS` per case (helper restores
  after). Existing `qr-scan` (21) + `orders` (2) suites must stay green with
  the config empty (legacy default).