# Brands operations guide

**Audience:** each brand/client using your loyalty program. You use the **same
OfferKit deployment** as other brands, but your data, cards and reports are
isolated.

---

## 1. What you get

- **`/scan` (merchant terminal)** — staff can earn points or redeem rewards for your
  customers. Protected by your **brand name + PIN**.
- **`/reports` (self-serve reports)** — you can view your own numbers at any time:
  KPIs, 30-day activity, recent scans, a searchable list of your customers and
  each customer's ledger/history. Protected by the same brand name + PIN.
- **`/card/[code]` (customer card)** — each card shows that customer's balance,
  tier and history for *your* program only.

You **do not** get access to other brands, and other brands cannot access yours.
Your card, phone membership and sales (bill numbers) are scoped to your brand.

---

## 2. Getting started

1. Your operator (agency) gives you two things out-of-band (never email the PIN):
   - **Brand name** (e.g. `ACME Coffee`)
   - **PIN** (e.g. `9012`)
2. Bookmark these pages for your location:
   - Terminal: `https://<your-offerkit-host>/scan`
   - Reports:  `https://<your-offerkit-host>/reports`
3. Test with a sample customer.

---

## 3. Merchant terminal (`/scan`)

Open `/scan`. If you see **Brand** and **PIN** fields, you're in multi-brand
mode.

1. Select or type your **Brand name** and enter your **PIN**.
2. Choose a mode: **Earn** (credit points) or **Redeem** (spend points on a reward).
3. Identify the customer by **card code** (preferred) or **phone number**.
4. For Earn: enter the **bill amount** (in major currency units) and a **unique
   bill number** (from your POS receipt/invoice number). Each bill number may be
   used only once **for your brand**.
5. For Redeem: pick an available reward for that member and confirm the spend.
6. The result shows the new balance. The PIN is cached per browser tab/session
   for a shift; if you sign out or switch devices, re-enter it.

**Notes:**

- If a phone hasn't shopped with you before, the terminal will prompt for the
  customer's name (and optionally email) and will **auto-enroll** them into your
  loyalty program.
- You cannot redeem a card from another brand here — you'll see `wrong_brand`.
- The same bill number at a different brand is a completely separate transaction
  and won't collide with yours.

---

## 4. Read-only reports (`/reports`)

Open `/reports` with the same brand name + PIN.

- **Overview** — total customers/members, points earned/spent/outstanding, bills,
  revenue.
- **Last 30 days** — a daily bar/line view of activity.
- **Recent scans** — the latest bill credits.
- **Customers** — search by name/email/phone/card; see tier, balance, lifetime
  points, number of bills, revenue, last activity. Click a customer to open
  their detail.
- **Customer detail** — profile, tier progress, KPIs, full **points ledger**
  (shows when tier changed — the "Tier" column shows the tier at/after each
  entry), and their **scan history**.

All numbers are scoped to **your brand only**.

---

## 5. Customer cards (`/card/[code]`)

Customers open `https://<your-offerkit-host>/card/<their-8-char-card-code>` to
see their balance, current tier, tier progress, history and rewards available in
your program. This view is read-only and always shows data for the program
attached to that card (your brand).

---

## 6. Housekeeping & security

- **PIN rotation**: your operator can reset your PIN at any time. Use a new one
  immediately and don't share it widely.
- **Staff access**: treat the PIN like a terminal key. If it leaks, ask to
  rotate it.
- **Bill numbers**: use POS invoice/receipt numbers that are unique per sale in
  your store(s). If you reuse numbers, you'll get a replay/idempotent response
  (safe, won't double-credit).
- **Data boundaries**: you cannot see other brands' customers, redemptions,
  orders or programs. Your operator sees all brands for support/reconciliation.
- **Read-only**: `/reports` is strictly read-only — no enrollments, adjustments
  or deletions from that page.

If something looks off (wrong brand, missing data, or a bill credit failing),
share the **bill number**, **card/phone**, **time** and the error message with
your operator. They'll look up the exact redemption in their workspace-wide
ledger.
