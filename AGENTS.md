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
- **Phone is an alias, not an identifier** (per OfferKit's `externalId` guidance:
  never key on mutable/PII fields). `getMemberByPhone` matches the **last 10
  digits** of `customer.phone` (formatting-insensitive: `+91 90964 44567` =
  `090964 44567` = `9096444567`). Card `/card/[code]` URLs always use the opaque
  card code, never the phone, so balances aren't enumerable by phone.
  (Deviation from the strict spec: phone is a *terminal convenience*, not the QR).
- **Quick-enroll** (second step of `/scan`): when a phone matches no member,
  the UI asks for the customer's **name + email** (captured metadata), then
  `quickEnroll` finds the existing customer by phone (or creates one), enrolls
  in the program (`programId`, defaulting to `resolveDefaultQrProgram` = newest
  `LOYALTY_PROGRAM`), mints the card code, then credits. Response includes
  `cardCode` + `enrolled: true`. The membership transaction commits before the
  code is minted (a write inside the open transaction deadlocks
  single-connection/test DBs).
- Card codes are **case-insensitive** on lookup, but the API regex rejects
  whitespace/non-alphanumerics before normalization.
- Earning rule selection: active rule with `event: "qr.scan"` → any active
  rule → fallback `per_cents/100` (1 pt per major unit).
- `loyaltyMemberOutput` now includes optional `cardCode`; `members.get`
  mints one on demand (lazy `ensureCardCode`).
- Unit tests: `packages/core/src/loyalty/qr.test.ts`.
  E2E: `apps/web/src/server/router/flows/qr-scan.e2e.test.ts` (16 cases).

### POC limitations (deliberate, next steps)

- **`/scan` is unauthenticated** — flip `authorizeScan()` in
  `apps/web/src/server/qr-loyalty/authorize.ts` (one file, all call sites covered).
  Planned: shared PIN, architected to accept guards later.
- No QR image (skipped for POC) and no camera scan — manual code entry only.
  Adding a QR later: encode `https://host/card/[code]`; repo has **no QR lib**
  (would need `qrcode` or `next/og` + encoder).
- No `Idempotency-Key` on the public scan route itself — idempotency rides on
  the **`billNumber`** body field instead (`eventId = qr:{billNumber}`).
- No webhook/event emitted on `scanEarn` (core `earn` doesn't `emitEvent`).
- Card code is a bearer secret — anyone with it can see the balance.
- `quickEnroll` locks nothing: two concurrent swipes for the same unknown phone
  can race and create two customers (no unique index on phone, by design).
- Single-currency assumption: amount entered in major units, ×100 to minor.

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
