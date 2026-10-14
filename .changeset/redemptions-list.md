---
"@offerkit/sdk": patch
"@offerkit/mcp": patch
"@offerkit/cli": patch
---

Add a `redemptions.list` endpoint that returns a workspace-wide redemption ledger — every voucher redemption attempt with its outcome (`SUCCESS` / `FAILURE` / `ROLLBACK`), amount, customer, voucher code, order reference and timestamp. Supports cursor pagination and `search`, `result`, `campaignId` and `voucherId` filters, and is exposed as an MCP tool for agents.
