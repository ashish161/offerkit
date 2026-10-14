---
"@offerkit/sdk": patch
"@offerkit/mcp": patch
"@offerkit/cli": patch
---

Return a `customer_not_found` redemption failure instead of an internal server error when a supplied `customerId` does not exist.

Previously `redeem`/`stackRedeem` (and `validate`) forwarded the unknown customer id downstream, violating the `redemption.customer_id` foreign key and surfacing as an HTTP 500. Redemption now fails cleanly with a `customer_not_found` code (added to the redemption failure codes), matching the existing `customer_mismatch` / `customer_required` behaviour.
