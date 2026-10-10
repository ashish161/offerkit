# Loyalty Points Expiry — approaches, open questions & recommendations

**Status:** design / not implemented
**Branch context:** discovered on `feature/multi_tenant`; the actual fix is an
**engine change** (see §9), so it should land on its own branch.
**Related:** `docs/multi-tenant-poc.md` §6 (upstream-merge discipline),
`packages/core/src/loyalty/index.ts`, `packages/db/src/schema/loyalty.ts`.

## 1. The problem: docs promise expiry, the engine never applies it

OfferKit's own docs describe points expiry as a shipped, program-configured
feature:

| doc | text |
|---|---|
| `apps/site/content/docs/solutions/loyalty.mdx:20-21` | "decide whether earned points expire. OfferKit can record **per-entry expiration** and run a **background expiration sweep**." |
| `…/loyalty.mdx:27` | "Set the **point-expiration period** if points should not live forever." |
| `…/loyalty.mdx:8,114,126` | the ledger carries "expiration entries"; test "expiration of several earning entries." |
| `apps/site/content/docs/operate/troubleshooting.mdx:67,70` | compare the earn entry's "expiration timestamp"; "Check the **worker** and expiration entries if points disappeared after their expiry date." |
| `apps/site/content/docs/self-host.mdx:29` | the worker "re-seeds the recurring `loyalty.points.expire` sweep." |

The mechanics exist — the `points_expiry_days` program field, the
`expires_at`/`expired_at` columns, the `expirePoints()` function, and the worker
job that runs it. What is **missing is the link**: nothing reads
`loyalty_program.points_expiry_days` to stamp `expires_at` on an earn entry, so
every entry is created with `expires_at = NULL` and the sweep finds nothing.

### Empirical proof

Against a program with `points_expiry_days = 90` (Brand 3,
`00a59340-0e0e-4801-b8a2-a854310892a2`), a QR scan credited points successfully
but the inserted `loyalty_transaction` row had `expires_at = NULL` ⇒ **the points
never expire.** The scan path calls `earn()` with no `expiresAt`
(`packages/core/src/loyalty/qr.ts:516`).

```
 doc says                                   code does
 ─────────────────────────────────────      ─────────────────────────────────────────
 "set the point-expiration period"   ──▶    stored on loyalty_program.points_expiry_days
 ("…per-entry expiration")                  BUT never copied onto loyalty_transaction.
                                            expires_at                            ← GAP
 "background expiration sweep"       ──▶    ✓ expirePoints() + worker job (matches)
 "expiration entries" (ledger)       ──▶    ✓ EXPIRY rows (matches)
 "expiration timestamp" per entry    ──▶    ✓ column exists, stays NULL
```

So the docs are **ahead of the implementation**, not wrong.

## 2. How the engine works today (reference)

- **Schema** (`packages/db/src/schema/loyalty.ts`)
  - `loyalty_program.points_expiry_days` `integer null` (:26) — `null` = never
    expire.
  - `loyalty_transaction.expires_at` `timestamptz null` (:180),
    `expired_at` `timestamptz null` (:181). Index on `expires_at` (:186).
  - `loyalty_member.balance` is a **materialized cache**; the ledger is the
    source of truth and rebuildable (:130-131).
- **`earn()`** (`packages/core/src/loyalty/index.ts:83`) writes
  `expiresAt: input.expiresAt ?? null` (:127). It **never** consults the
  program. `EarnInput.expiresAt?: Date` (:60) exists but the only production
  caller that fills it is the manual REST endpoint, which takes it from the
  request body (`apps/web/src/server/router/loyalty.ts:409`) — not from the
  program either.
- **`adjust()`** (:318) routes positive deltas through `earn()` with
  `reason: "ADJUSTMENT"` (:329); `earn()` does **not** set `expires_at` on
  adjustments today, and arguably never should.
- **`redeemReward()`** (:178) simply checks `balance >= cost`, writes one
  REDEEM row with `delta = -cost` (:214), and decrements `balance` (:211). There
  is **no FIFO and no lot allocation** — it does not record *which* earns were
  spent.
- **`expirePoints(db, now)`** (:373) selects EARN rows with
  `expires_at < now AND expired_at IS NULL AND delta > 0 AND reason = 'EARN'`
  (ordered by `expires_at`, limit 1000) and, per row, writes an EXPIRY row of
  `delta = -row.delta` (:399) and sets the row's `expired_at` (:408).
- **`rollbackTransaction()`** (:246) reverses one transaction by id; it refuses
  to roll back a ROLLBACK or EXPIRY (`:257`).
- **Worker sweep** (`apps/worker/src/handlers.ts:37`): on each run it calls
  `expirePoints(db)` and re-enqueues itself `+24h`
  (`LOYALTY_EXPIRE_INTERVAL_MS`, :10). Seeded on boot in
  `apps/worker/src/index.ts`. Nothing runs it on a dev box.

## 3. What "correct" requires

Three requirements, in order of increasing difficulty:

- **R1 — stamp.** An earn entry created under a program with
  `points_expiry_days = N` gets `expires_at = earned_at + N days`. A caller
  may still override with an explicit `expiresAt`; non-expiring programs stay
  `NULL`.
- **R2 — expire only the unspent remainder.** When a lot expires, cancel only
  the points in that lot that are *still available*, not the full original
  `delta`. Otherwise balances go negative and members lose points they never had.
- **R3 — FIFO.** Redemptions (and other debits) consume the **oldest** lots
  first, so "which points are unspent" is well-defined and the remainder in R2
  is computed correctly.

### Why the obvious shortcut is wrong

The current sweep effectively does "expire `delta`, let balance go negative."
The tempting fix — expire `min(delta, balance)` oldest-first — is **still
wrong**. Counterexample:

```
earn A: 100 pts, expires day 7
earn B: 100 pts, expires day 30
redeem 150 on day 5              → balance 50
                                 (FIFO: A fully spent, B has 50 left)

day 7 sweep, lot A is due:
  min(A.delta=100, balance=50) = 50  → expire 50 ⇒ balance 0   ✗ WRONG
  correct: A's remainder is 0 (already spent) → expire 0, balance stays 50  ✓
```

You cannot know A's remainder from `balance` alone; you must know **lot-level
consumption**. That is the whole crux, and it is what R3 buys you.

## 4. Approaches

### A. Derived FIFO at sweep — **recommended**

Stamp on earn (R1). For expiry, **replay the member's ledger** in
`createdAt` order maintaining a FIFO queue of open lots; a lot's remainder is
what no later debit consumed. Expire each due lot's remainder (R2). No schema
migration and no change to `redeemReward`.

- **Pros:** no migration; the ledger stays the single source of truth and is
  fully rebuildable; matches the fork's existing "derive, don't store" pattern
  (the customer-report tier timeline is derived the same way); smallest
  upstream-merge surface.
- **Cons:** the replay must model every row type (EARN, ADJUSTMENT ±, REDEEM,
  EXPIRY, ROLLBACK) and get ordering/ties right (§5); O(history) per member
  swept, so scope the replay to members that actually have due lots.
- **Where:** `expirePoints()` + a new pure helper `computeLotRemainders(txs)`
  in `packages/core/src/loyalty/`; `earn()` for R1.

### B. Materialized allocation

`redeemReward()` records which lots it spent. Either a new nullable
`source_earn_id` self-reference on `loyalty_transaction` (one REDEEM row per lot
consumed) or a dedicated `loyalty_point_allocation` table
`(earn_tx_id, redeem_tx_id, amount)`.

- **Pros:** expiry becomes `remaining = delta - Σ(consumed)` — explicit, O(1),
  auditable ("this redemption drew from these lots"), easy to reason about.
- **Cons:** schema migration + new index; changes REDEEM row shape (history UI
  and any consumers see multiple rows per redeem, or a new join); must be kept
  consistent on rollback of a redeem and on legacy rows written before the
  change (backfill/replay needed).

### C. Track `remaining` on the EARN row

Add `loyalty_transaction.remaining int` (defaults to `delta` on EARN), decremented
when redeemed FIFO; sweep expires `remaining` and sets it to 0.

- **Pros:** simplest to read at sweep time; one new column.
- **Cons:** a mutable counter on an otherwise append-only ledger — it is **not**
  rebuildable from the ledger alone (`recomputeBalance` still works because it
  sums `delta`, but `remaining` cannot be reconstructed without replay), and it
  must be updated on every redeem and rollback. Weakens the "ledger is source of
  truth" invariant in §2.

| | migration | rebuildable | redeem rows change | rollback cost | upstream risk |
|---|---|---|---|---|---|
| **A derived** | none | yes | no | replay handles it | lowest |
| **B allocation** | yes (col/table) | yes | yes | delete/reverse allocation | medium |
| **C remaining** | yes (col) | no | no | must restore counter | medium |

## 5. FIFO details & edge cases (the hard part)

These apply mainly to Approach A; B/C need the same decisions baked into their
write paths.

1. **Ordering & ties.** Replay must be deterministic: `createdAt ASC, id ASC`.
   `createdAt` is `defaultNow()` and can collide for rows written in one
   statement/transaction; a stable tiebreak is mandatory.
2. **ADJUSTMENT.**
   - Positive adjustment adds spendable balance but has **no `expires_at`** ⇒
     treat as a **non-expiring lot** at the back of the queue (never expires).
   - Negative adjustment is a debit ⇒ consumes from the front, like a redeem.
3. **ROLLBACK.**
   - Rollback **of an EARN** removes points from that specific lot (reduce its
     remaining; it may also already be partly consumed).
   - Rollback **of a REDEEM** returns points; FIFO-faithful re-add means putting
     them back on the lots the redeem consumed (needs the allocation from B, or
     a re-simulation from A). A pragmatic fallback is to re-add as a
     non-expiring lot — simpler but drifts from strict FIFO.
   - Rollback rows are themselves keyed by `note = "rollback {id}"` today; the
     replay needs the link to be robust (prefer a real column over note-parsing).
4. **EXPIRY idempotency.** Each lot is capped at **one** expiry
   (`expired_at IS NULL` filter). The sweep sets `expired_at` and writes one
   EXPIRY row; a re-replay must treat an existing EXPIRY row as "this lot is
   closed", not double-count it.
5. **Concurrent sweeps.** Two workers (or a retried job) could both see the same
   due lot. Expiry must re-check `expired_at IS NULL` under a row lock inside
   the transaction (the current code locks the *member*, not the lot). Prefer
   `SELECT … FOR UPDATE` on the candidate lot, or a conditional
   `UPDATE … WHERE expired_at IS NULL RETURNING` and skip if 0 rows.
6. **Program setting changes / retroactivity.** Is `points_expiry_days` read at
   earn time (each lot freezes its own expiry) — **yes, recommended** — or
   re-evaluated at sweep time against the current setting? Freezing is
   predictable; the trade-off is that lowering the period does not shorten
   already-issued points, and raising it does not rescue them. State this
   explicitly because it is user-visible.
7. **Sweep window & "now".** Doc says "disappeared after their expiry date."
   Decide whether a lot expires at `expires_at <= now` or `< now`, and the
   exact granularity (day vs instant). Currently `expiresAt < now` with a daily
   sweep, so a lot can live up to ~24h past its nominal expiry. Acceptable, but
   document it.
8. **Backfill.** Existing rows have `expires_at = NULL`. Do we backfill
   `expires_at` for historical earns under a program that had a period set?
   Recommend **no** (avoid retroactively expiring real balances); new earns only.
9. **Performance.** Approach A replays per member. Restrict to members with
   ≥1 due lot (`SELECT DISTINCT member_id FROM loyalty_transaction WHERE
   expires_at < now AND expired_at IS NULL AND delta > 0 AND reason='EARN'`),
   then replay each. At POC scale trivial; note the ceiling.
10. **`limit 1000`.** The candidate query caps at 1000 rows per sweep with no
    pagination — a large backlog is silently deferred a day. Note/fix.
11. **Membership deleted / soft-deleted program.** `earn()` and the sweep
    handle a missing member by skipping (`:397`). Confirm that is intended vs
    an error signal.

## 6. Open questions

1. **Setting scope:** should `pointsExpiryDays` apply only to `reason = "EARN"`,
   or to positive `ADJUSTMENT` too? (Recommend: EARN only; adjustments are
   operator corrections, not earned lots.)
2. **Caller override vs program default:** if both an explicit `expiresAt` and
   a program period exist, which wins? (Recommend: explicit `expiresAt` wins;
   program is the default.)
3. **Un-credited expiry:** should a lot that has been *partly* spent expire only
   its remainder (R2) — yes — and should we emit a domain event
   (`loyalty.points.expired`) so integrations can notify members? (Docs imply
   only ledger entries; an event is a nice-to-have.)
4. **Rollback of a redeem:** strict FIFO re-add (needs allocation) vs pragmatic
   non-expiring re-add. Which fidelity do we need?
5. **Retroactivity:** freeze expiry at earn time, or follow the live program
   setting? (See §5.6.)
6. **Negative-balance policy:** after this fix can balance ever go negative? If
   R2 is done right, no — but legacy negative balances may exist from the old
   sweep. Do we add a one-time correction?
7. **Order of operations on same-day events:** earn then redeem then expire
   within one day — confirm replay order by timestamp is acceptable.
8. **Dashboard surfacing:** should `/card/[code]` and `/reports` show per-entry
   expiry / "expiring soon" buckets? (Out of engine scope; May follow.)
9. **Migration/upstream:** if B/C, do we accept a schema migration, given the
   journal-collision dance in `docs/multi-tenant-poc.md` §6?

## 7. Recommendations

1. **Do R1 immediately and independently** — it is small, correct, and
   unblocks the docs' promise: in `earn()`, when `reason === "EARN"` and
   `input.expiresAt` is undefined, load the program and set
   `expires_at = now + points_expiry_days` when set.
2. **Implement R2/R3 via Approach A (derived FIFO)** to avoid a migration and
   keep the append-only ledger rebuildable — consistent with the fork's
   existing derived-computation style. Factor a pure, unit-testable
   `computeLotRemainders(txs)`.
3. **Freeze expiry per lot at earn time** (§5.6); do **not** backfill history.
4. **Harden the sweep** for concurrency and idempotency (§5.4–5.5) and remove
   the 1000 cap or paginate it (§5.10).
5. **Land it on a dedicated branch** (e.g. `feat/loyalty-expiry`) off `main`,
   with a changeset, leaving `feature/multi_tenant` untouched.
6. If B's explicit allocation is later wanted for auditing, it can be layered on
   top of A without changing external behavior.

## 8. Test plan

- **Unit — `computeLotRemainders`:** the §3 counterexample; fully-spent oldest
  lot; partial frontier lot; positive/negative adjustment; earn rollback;
  redeem rollback; expiring + non-expiring mix; tie on `createdAt`.
- **E2E — `expirePoints`:** lot expires its remainder not its `delta`; balance
  never negative; `expired_at` set; second sweep is a no-op (idempotent);
  non-expiring program sweeps nothing; concurrent sweeps credit once.
- **E2E — `earn`:** program with `pointsExpiryDays = N` stamps
  `expires_at ≈ now + N`; explicit `expiresAt` overrides; `null` program leaves
  `NULL`; ADJUSTMENT unstamped.
- **E2E — QR scan:** via `scanEarn` on a program with a period, the ledger row
  now carries `expires_at` (regression for the Brand 3 finding).
- **Worker:** `loyalty.points.expire` handler runs the sweep and re-enqueues
  +24h.

## 9. Out of scope / upstream notes

- Implementing this **touches engine files** (`packages/core`, and
  `packages/db` if Approach B/C), so it **must not** ride on
  `feature/multi_tenant`, whose hard rule is zero engine changes
  (`docs/multi-tenant-poc.md`). Do it on a separate branch.
- Approach B/C additionally require a Drizzle migration, which interacts with
  the fork's migration-number-collision process (`docs/multi-tenant-poc.md` §6).
- Approach A needs **no** migration.
- Surfacing expiry in the dashboard (`/card/[code]`, `/reports`) is a separate,
  read-only follow-up.

## 10. References

| file | what |
|---|---|
| `packages/core/src/loyalty/index.ts:83` | `earn()` — writes `expiresAt` only if supplied (:127) |
| `packages/core/src/loyalty/index.ts:178` | `redeemReward()` — no FIFO/allocation |
| `packages/core/src/loyalty/index.ts:246` | `rollbackTransaction()` — refuses EXPIRY/ROLLBACK (:257) |
| `packages/core/src/loyalty/index.ts:318` | `adjust()` — positive → `earn()`, negative → direct row |
| `packages/core/src/loyalty/index.ts:373` | `expirePoints()` — candidate query (:374), full-delta EXPIRY row (:399) |
| `packages/core/src/loyalty/index.ts:422` | `recomputeBalance()` — sums all deltas |
| `packages/core/src/loyalty/qr.ts:516` | `scanEarn` → `earn()` call with no `expiresAt` |
| `apps/web/src/server/router/loyalty.ts:409` | manual earn takes `expiresAt` from request body only |
| `apps/worker/src/handlers.ts:37` | `loyalty.points.expire` job; re-enqueues +24h (:10) |
| `packages/db/src/schema/loyalty.ts:26,180,181` | `points_expiry_days`, `expires_at`, `expired_at` |
| `apps/site/content/docs/solutions/loyalty.mdx:20-21,27` | docs: per-entry expiration + sweep |
| `apps/site/content/docs/operate/troubleshooting.mdx:67,70` | docs: expiration timestamp / worker |
