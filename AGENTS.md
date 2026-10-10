# AGENTS.md — OfferKit knowledge base

Read this before making changes. It exists so agents don't have to re-explore
the repo. Update it when you learn something that cost exploration time.

Repo: agent-first, self-hostable promotion engine (coupons, gift cards,
loyalty, referrals, segments, validation rules) + dashboard, REST API, SDK,
CLI, MCP server. MIT, monorepo (pnpm workspaces + turbo).

---

## 1. Dev environment

- **Node 26.5.1 + pnpm 11.20.0 required** (`engines` is enforced). Install via
  `export PNPM_HOME="$HOME/Library/pnpm"; export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"; pnpm env use --global 26.5.1`.
  The PATH export must be in the same shell invocation (it does not persist
  across separate shells). Without it, lefthook pre-commit hooks fail on
  `ERR_PNPM_UNSUPPORTED_ENGINE`.
- **Local runs:** `pnpm --config.engine-strict=false --filter @offerkit/web dev --port 31000`
  (used while local Node was still 24; with Node 26 installed, plain `dev` works).
- **Ports:** `:3000` Docker web (published image), `:31000` local `next dev`,
  `:5432` Postgres, `:6379` Redis (both from `docker compose up -d postgres redis`).
- `.env` at repo root is the single env source. Next.js does **not** read it
  from `apps/web/` — `apps/web/.env.local` is a symlink to `../../.env`
  (gitignored). Without it you get `BETTER_AUTH_SECRET is not set` (500s).
- DB creds in `.env`: `postgres://offerkit:dev@localhost:5432/offerkit`.
  Local dev and Docker services share the same DB.
- Demo admin: `admin@example.com` / `changeme123` (first sign-in forces change).

### Commands

```bash
pnpm -r typecheck            # or pnpm --filter <pkg> typecheck
pnpm -r lint
OFFERKIT_TEST_PGLITE=1 pnpm --filter '!@offerkit/site' -r test   # CI-style, in-memory PG
OFFERKIT_TEST_PGLITE=1 pnpm --filter @offerkit/web exec vitest run <file>   # single suite
pnpm --filter @offerkit/web reset-demo [--qr-only] [--dry-run]  # hard teardown of demo data
pnpm --filter @offerkit/web seed-reporting-demo [--per-brand=7] [--yes]  # realistic per-brand data for /reports
```

- All app deletes are **soft** (`deleted_at`) — customer/campaign/program deletes never cascade.
  The one exception is `reset-demo` (`apps/web/scripts/reset-demo.mts`), which hard-deletes
  `campaign` + `customer` roots so the DB FK cascades (→ programs → tiers/rules/rewards →
  members → point transactions) finally fire. It's a CLI (`node` type-stripping, no tsx),
  prompts before deleting unless `--yes`. **Dev-only guard:** refuses to run unless
  `DATABASE_URL` host is `localhost`/`127.0.0.1`/`::1` (or unix socket); `--force` bypasses.
```

- Pre-commit (lefthook) runs lint + typecheck + test on every commit — full
  suite ≈ 60–80 s. E2E suites skip unless `TEST_DATABASE_URL`/`DATABASE_URL`
  or `OFFERKIT_TEST_PGLITE=1` is set.
- PGlite init can time out (30 s hook) when the dev server + Docker are under
  load — failures move between files across runs; rerun in isolation before
  assuming a real break.

---

## 2. Architecture map

```
packages/contract   oRPC contract (routes/ + schemas/) — single source of truth
packages/db         Drizzle schema (src/schema/*) + migrations (drizzle/NNNN_*.sql)
packages/core       Domain logic (loyalty, redemption, codes, jobs, events, rules…)
packages/sdk        Typed client — derived from contract + OpenAPI (no codegen)
packages/mcp        MCP server (stdio + http)
packages/cli        offerkit CLI
apps/web            Next.js 16 dashboard + REST API + all server routers
apps/worker         BullMQ/Postgres job worker
apps/site           Astro + Fumadocs site/docs (content/docs, content/next)
```

### Request flow

REST: `GET/POST /api/v1/**` → `apps/web/src/app/api/v1/[[...rest]]/route.ts`
(OpenAPIHandler) → `apps/web/src/server/router/*.ts` (handlers implement the
contract) → `packages/core` → `packages/db`.

- Contract → OpenAPI → SDK → MCP all update **automatically** when you add a
  procedure to `packages/contract/src/router.ts`.
- Scopes derive from the path (`loyalty:read`, `loyalty:write`, `loyalty:redeem`) —
  see `apps/web/src/server/middleware/scopes.ts`.
- `.meta(mcpMeta({riskLevel}))` drives MCP hints + audit + idempotency
  (`packages/contract/src/mcp.ts`); defaults: GET=safe, DELETE=destructive,
  else=mutating.

### Auth

- `requireSession` (`apps/web/src/server/middleware/auth.ts`) is all-or-nothing:
  API key (`Authorization: Bearer offerkit_…`) → session cookie →
  `context.trustedUser` (hosted MCP only). Only `/health` and `/ready` are public.
- API keys: HMAC-peppered with `BETTER_AUTH_SECRET` (`apps/web/src/lib/api-key.ts`),
  in-memory rate limit, generic `Idempotency-Key` support for mutations.
- Public (sessionless) surfaces are the exception — see §4.

---

## 3. Common changes — checklist

**Add an API endpoint**
1. `packages/contract/src/schemas/<x>.ts` + `routes/<x>.ts` (export `oc.route(...)`)
2. Register in `packages/contract/src/router.ts`
3. Implement in `apps/web/src/server/router/<x>.ts` with
   `implement(contract).$context<RequestContext>().use(requireSession)`
4. Register router in `apps/web/src/server/router/index.ts`
5. Test: `apps/web/src/server/router/flows/<x>.e2e.test.ts` using
   `getTestDb` / `mintTestKey` / `makeClient` from `./_helpers`
   (see `flows/loyalty.e2e.test.ts` as template)

**Change the DB**
1. Edit `packages/db/src/schema/<file>.ts`
2. `pnpm --filter @offerkit/db generate` → new `drizzle/0024_*.sql` (next index;
   check `drizzle/meta/_journal.json`). Never `push` for real changes —
   migrations auto-run on web boot (`apps/web/src/instrumentation.ts`).

**Add a job type**
1. Handler: `apps/worker/src/handlers.ts` → `registry.register("your.type", …)`
2. Produce: `enqueueJob(db, "your.type", payload, { runAt? })` from `@offerkit/core/jobs`

**Add a public page/route** (outside dashboard guard)
- Dashboard pages under `app/(dashboard)/` are guarded by
  `requireDashboardSession()` in its `layout.tsx`. Anything else is public.
- Next 16: `params`/`searchParams` are **Promises** — `const { id } = await params`.
  Read `node_modules/next/dist/docs/` before writing pages (see `apps/web/AGENTS.md`).
- Server components: `import { T } from "gt-next"`; client: `"gt-next/client"`.

**Lint/type gotchas**
- No explicit `any` (eslint rule). i18n: every user-facing string in `<T>…</T>`.
- `DecimalInput`/`parseDecimalToMinorUnit` in
  `components/dashboard/voucher-form.tsx` for money inputs;
  `lib/money.ts:formatMinorCurrency` for display (minor units → locale string).
- **List endpoints must reuse `paginationInput`** (`schemas/pagination.ts`): its
  `limit` accepts number *or* numeric string, which is what REST query strings
  send. Declaring `limit: z.number()` in a list schema silently breaks the
  dashboard page (400 → empty list, error swallowed). See `schemas/order.ts`.

---

## 4. QR Loyalty POC (built, on `main`)

A customer loyalty flow that runs **alongside** an existing POS — no POS
integration. Customer gets a card code; merchant types code + bill amount;
points are credited using the program's earning rule.

### Flow

1. Admin creates a `LOYALTY_PROGRAM` campaign + program + earning rule in the
   dashboard (e.g. `kind: "per_cents", divisor: 1000` = ₹10 bill → 1 pt,
   amount is in **minor units**: paise).
2. Admin enrolls a customer → member gets an 8-char card code
   (uppercase, confusables excluded), minted lazily. **Or** the merchant
   quick-enrolls at the terminal: an unknown phone + customer name →
   `POST /api/scan` creates customer + member + mints the code in one shot
   (`quickEnroll` in core; default program = newest `LOYALTY_PROGRAM`).
3. Customer opens **`/card/[code]`** → balance, tier, tier progress, history.
4. Merchant opens **`/scan`** → enters card code **or customer phone** + bill
   amount + unique **bill number** → `POST /api/scan` → points credited (tier
   multiplier applies) → new balance shown.

### Layering (keep it this way)

| layer | what lives there |
|---|---|
| `packages/db` | `loyalty_member.card_code` (unique, nullable) — migration `0024_handy_piledriver.sql` |
| `packages/core/src/loyalty/qr.ts` | ALL logic: `computeEarnPoints`, `resolveScanEarningRule`, `ensureCardCode`, `getMemberByCardCode`, `getMemberByPhone`, `normalizePhone`, `quickEnroll`, `resolveDefaultQrProgram`, `scanEarn`, `getCardDetails` — UI-agnostic |
| `apps/web/src/server/qr-loyalty/` | thin adapters: `scan.ts` (parse/validate → call core), `authorize.ts` (**guard stub**) |
| `apps/web/src/app/api/scan/route.ts` | `POST` → `handleScan` |
| `apps/web/src/app/card/[code]/page.tsx` | public RSC card page |
| `apps/web/src/app/scan/page.tsx` | public client merchant form |

Re-exported from `@offerkit/core/loyalty` (see end of `loyalty/index.ts`).

### Key semantics

- `POST /api/scan` body: `{ cardCode?, phone?, amount /* major units */, billNumber }`.
  At least one of `cardCode`/`phone` is required (card code takes precedence).
  → `{ok, delta, balance, basePoints, earningRuleId, alreadyCredited, …}`;
  404 `member_not_found`, 400 `validation_error`, 409 `alreadyCredited` (bill
  replay on same member) or `bill_already_processed` (bill replay on another
  member), 422 other loyalty failures.
- **`billNumber` is the idempotency key** — mirrored from the POS bill/invoice.
  Stored as ledger `eventId = "qr:{billNumber}"` (`billEventId`); the lookup is
  **global across members**: replaying a processed bill returns the original
  result with `alreadyCredited: true` + **409** (same member, idempotent retry),
  or `bill_already_processed` + **409** if the same bill is replayed for another
  member. This mirrors the spec: the application decides when a purchase
  qualifies, OfferKit doesn't auto-discover sales.
  - Backed by a **partial unique index** on `loyalty_transaction.event_id`
    (migration `0025_sharp_korath.sql`), so the read-then-write check can't
    double-credit under concurrency. `scanEarn` catches the losing tx's
    `23505` (`isUniqueViolation`, which walks `DrizzleQueryError.cause`) and
    returns the winner's result as an idempotent replay instead of a 500.
- **Phone is an alias, not an identifier** (per OfferKit's `externalId` guidance:
  never key on mutable/PII fields). `getMemberByPhone` matches the **last 10
  digits** of `customer.phone` (formatting-insensitive: `+91 90964 44567` =
  `090964 44567` = `9096444567`). Card `/card/[code]` URLs always use the opaque
  card code, never the phone, so balances aren't enumerable by phone.
  (Deviation from the strict spec: phone is a *terminal convenience*, not the QR).
- **Quick-enroll** (second step of `/scan`): when a phone matches no member,
  the UI asks for the customer's **name** (required) + **email** (optional;
  only captured when the customer shares it), then `quickEnroll` finds the
  existing customer by phone (or creates one), enrolls in the program
  (`programId`, defaulting to `resolveDefaultQrProgram` = newest
  `LOYALTY_PROGRAM`), mints the card code, then credits. Response includes
  `cardCode` + `enrolled: true`. The membership transaction commits before the
  code is minted (a write inside the open transaction deadlocks
  single-connection/test DBs).
- Card codes are **case-insensitive** on lookup, but the API regex rejects
  whitespace/non-alphanumerics before normalization.
- Earning rule selection: active rule with `event: "qr.scan"` → any active
  rule → fallback `per_cents/100` (1 pt per major unit).
- **A credited scan mirrors an order + emits an event.** Inside the *same*
  transaction as the point credit (`earn`'s optional `onEarned` hook —
  `packages/core/src/loyalty/index.ts`), `scanEarn` (a) inserts an `order`
  (`externalId = billNumber`, `status: "PAID"`, `amount`, `currency` from
  campaign, empty `items`, `metadata.source = "qr.scan"`) so scans appear on the
  Orders page, and (b) emits `loyalty.points.earned` (payload includes
  member/customer/bill/amount/delta/balance/tier/`orderId`) so Events +
  webhooks fire. Only on a real credit — bill replays create neither. Response
  includes `orderId`. This is a *mirror* of the POS bill, not a replacement for
  an itemised POS integration (the unique `order.externalId` would collide if a
  real integration later pushed the same bill numbers).
- `loyaltyMemberOutput` now includes optional `cardCode`; `members.get`
  mints one on demand (lazy `ensureCardCode`).
- Unit tests: `packages/core/src/loyalty/qr.test.ts`.
  E2E: `apps/web/src/server/router/flows/qr-scan.e2e.test.ts` (19 cases).

### POC limitations (deliberate, next steps)

- **`/scan` is unauthenticated** — flip `authorizeScan()` in
  `apps/web/src/server/qr-loyalty/authorize.ts` (one file, all call sites covered).
  Planned: shared PIN, architected to accept guards later.
- No QR image (skipped for POC) and no camera scan — manual code entry only.
  Adding a QR later: encode `https://host/card/[code]`; repo has **no QR lib**
  (would need `qrcode` or `next/og` + encoder).
- No `Idempotency-Key` on the public scan route itself — idempotency rides on
  the **`billNumber`** body field instead (`eventId = qr:{billNumber}`).
- Card code is a bearer secret — anyone with it can see the balance.
- `quickEnroll` locks nothing: two concurrent swipes for the same unknown phone
  can race and create two customers (no unique index on phone, by design).
- Single-currency assumption: amount entered in major units, ×100 to minor.

### Multi-tenant QR loyalty (branch `feature/multi_tenant`)

Lets one deployment serve several brands at the scan terminal. Config is a single
env var, read at **request time**:

- **`MULTI_TENANT_BRANDS`** — JSON map `{"BrandA":{"programId":"<uuid>","pin":"1234"},…}`.
  Unset/empty/invalid JSON ⇒ **legacy single-brand mode** (today's behavior, no guard).

| file | role |
|---|---|
| `apps/web/src/server/qr-loyalty/brands.ts` | `parseBrands()` (per entry: uuid `programId` + non-empty `pin`; bad JSON/fields dropped → `{}`), `brandFromHeader()`, `listBrandNames()` (sorted) |
| `apps/web/src/server/qr-loyalty/authorize.ts` | `authorizeScan()` — legacy ⇒ `null`; else requires `X-Brand` + `X-Brand-Pin`, **constant-time** PIN compare (`timingSafeEqual`); 401 `unknown_brand` / `invalid_pin` |
| `apps/web/src/server/qr-loyalty/scan.ts` | **cards are brand-locked** (member `programId` ≠ brand ⇒ 403 `wrong_brand`); **phones are brand-scoped** — the phone's membership in *this brand's program* is credited, and a phone with no membership there is auto-enrolled into the brand's program on the fly (reusing the shared `customer` row when the phone is already known; otherwise 404 `member_not_found` so `/scan` prompts for a name). A shopper can hold memberships in several brands at once. Legacy path byte-for-byte |
| `apps/web/src/app/api/brands/route.ts` | `GET /api/brands` → `{ brands: string[] }` (sorted; empty in legacy mode) |
| `apps/web/src/app/scan/page.tsx` | brand `<select>` + PIN field (from `GET /api/brands`) sent as headers, PIN cached in `sessionStorage` per brand; **hidden in legacy mode** |
| `apps/web/src/server/qr-loyalty/reports.ts` | **read-only** per-brand reports: `getBrandReport(db, programId)` (summary, 30-day daily, top customers, recent scans), `getBrandCustomers(db, programId, { search, limit })` (customer list w/ tier, balance, lifetime, bills, revenue, last activity), `getBrandCustomerReport(db, programId, memberId)` (one customer: profile, tier + next tier, KPIs, points ledger, scans). The ledger carries a **derived tier timeline**: `lifetimeAfter` + `tierName`/`previousTierName`/`tierChanged`, reconstructed by replaying the ledger against the *current* ladder (there is no tier-history table — see below). Every query scoped to one `programId`, pure reads, no engine change. Mirrors `docs/multi-tenant-reporting.sql` |
| `apps/web/src/server/qr-loyalty/report-scope.ts` | `resolveReportScope(request)` — shared PIN gate for the report routes: `authorizeScan()` (same as `/api/scan`) → `{ programId }`, or legacy fallback `resolveDefaultQrProgram`; returns a ready 401/404 `Response` on failure |
| `apps/web/src/app/api/reports/route.ts` | `GET /api/reports` — brand aggregate, guarded by `resolveReportScope` |
| `apps/web/src/app/api/reports/customers/route.ts` | `GET /api/reports/customers?search=&limit=` — brand's customer list (same gate) |
| `apps/web/src/app/api/reports/customer/route.ts` | `GET /api/reports/customer?memberId=` — one customer's detail (same gate); non-UUID → 400, member of another brand → 404 `member_not_found` |
| `apps/web/src/app/reports/page.tsx` | public **read-only** brand report page: brand `<select>` + PIN (reuses `/api/brands` + `sessionStorage` PIN), KPI cards + daily/recent-scan tables, a searchable **Customers** table, and a per-customer panel (ledger + scans) whose ledger shows the **derived tier** per entry (highlights promotions). No mutations |

`apps/web/scripts/seed-reporting-demo.mts` (`pnpm --filter @offerkit/web
seed-reporting-demo [--per-brand=7] [--yes]`) seeds realistic per-brand activity
for `/reports`: reads brands from `MULTI_TENANT_BRANDS`, **simulates the engine's
earn logic** (tier multiplier + tier re-pick, so balances/lifetimes/tiers are
consistent), writes complete `customer`/`loyalty_member`/`loyalty_transaction`/
`order`/`event` rows backdated across ~26 days, and is **idempotent** (deletes
only its own rows, marked `customer.external_id = 'demo-seed:%'`). Dev-only guard
(refuses non-local `DATABASE_URL`).

**Per-brand bill namespacing:** in brand mode the adapter prefixes the POS bill
number with the brand (`{brand}:{bill}`) before calling `scanEarn`, because the
engine's idempotency key (`event_id = qr:{bill}`) and the mirrored
`order.external_id` are **globally unique**. Without the prefix, the same bill
number at two brands would collide (the second scan returns 409
`bill_already_processed`). So `BRAND A:TEST-123` and `BRAND B:TEST-123` are two
independent credits. Legacy mode passes the bill number through unchanged.

**Brand self-serve reporting (read-only):** a brand can view their own numbers
without a dashboard login at **`/reports`** — it asks for the **same brand + PIN**
as `/scan`. There are two levels: a **brand aggregate** (`GET /api/reports`:
KPI summary, 30-day daily activity, top customers, recent scans) and a
**customer level** (`GET /api/reports/customers` for the searchable list,
`GET /api/reports/customer?memberId=` for one customer's profile, tier/next-tier,
points ledger and scan history). All three are guarded by `resolveReportScope`
(`authorizeScan()` + `ctx.programId`) so a brand only ever sees its own program —
a member belonging to another brand returns 404 `member_not_found`. The page is
strictly read-only (no enroll/scan/adjust) and the aggregate mirrors
`docs/multi-tenant-reporting.sql`. In legacy mode it falls back to the newest
loyalty program.

**Tier history is derived, not stored.** `loyalty_member.current_tier_id` holds
only the *current* tier and `loyalty_transaction` has no tier column, so there is
no first-class record of when a customer changed tier (nor an audit entry — tier
only ever changes inside `earn()`). The customer report reconstructs a **tier
timeline** by replaying the member's ledger against the *current* ladder, anchored
to the member's current `lifetimePoints` (lifetime moves only on EARN `+delta`, and
best-effort on ROLLBACK-of-EARN; ADJUSTMENT/EXPIRY leave it flat). Caveat: it uses
today's thresholds, so changing the ladder retroactively rewrites the timeline. QR
scans *also* snapshot the post-earn `tierId` in the `loyalty.points.earned` event
payload, but non-scan tier changes (e.g. a manual positive ADJUSTMENT that
recomputes the tier) emit no event. For a durable record, emit a
`loyalty.tier.changed` event in `earn()` or add a tier-history table (both engine
changes, deliberately out of POC scope).

**Hard rule:** this feature touches **no engine files** — nothing in
`packages/core`, `packages/db`, `packages/contract`, or any upstream-owned
router. All changes live in the POC adapter files above, the `/scan` + `/reports`
pages, and config.

---

## 5. Product/docs notes

- Docs: `apps/site/content/docs/` (stable) and `content/next/` (unreleased) —
  kept near-identical; new feature docs go to `content/next` first. Register
  pages in the section's `meta.json`. Loyalty docs:
  `solutions/loyalty.mdx` (currently says customer UI is the integrator's job —
  the QR POC changes that positioning; update if it ships).
- The repo currently has **no seed/demo script** — only `seed-admin.ts`
  (first admin). QR demo data was seeded ad-hoc (campaign `QR POC Program`,
  rule `qr.scan`/divisor 1000).

---

## 6. Upstream-merge discipline (added after first upstream merge)

Our fork is `origin` (ashish161/offerkit); `upstream` = offerkit/offerkit.
Because the POC lives partly in files upstream also changes (`schema/loyalty.ts`,
`drizzle/meta/_journal.json`), every upstream pull is a manual merge.

- **Migration-number collisions are expected**: upstream and the fork both
  generate `NNNN_*` migrations from wherever their journal stands. Our fork
  journal is authoritative — on merge, keep our `0024_handy_piledriver` +
  `0025_sharp_korath`, drop upstream's `0024_dashing_prism`, then run
  `pnpm --filter @offerkit/db generate` so the *delta* is re-emitted as the next
  fork migration (`0026_…`) with a fresh snapshot. Never ship two `NNNN_*`
  migrations with the same number in one journal.
- **Keep-ours bias**: `AGENTS.md` conflicts resolve to the fork's version
  (upstream's "Agent Instructions" live in their history; reuse only rules that
  apply here — the fork owns its own release process).
- After every merge: `pnpm install`, then the full pre-commit run (typecheck +
  lint + test), then `pnpm --filter @offerkit/db migrate` against the dev DB.
- Upstream governance that also applies here: use the authenticated `gh` CLI for
  GitHub ops; add a changeset when a public package's behavior or interface
  changes; never merge/release/deploy unless explicitly asked.
