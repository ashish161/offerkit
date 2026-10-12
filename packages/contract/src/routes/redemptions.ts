import { oc } from "@orpc/contract";
import { z } from "zod";
import { mcpMeta } from "../mcp.ts";
import { paginatedOutput, paginationInput } from "../schemas/pagination.ts";
import { redemptionOutput, redemptionResult } from "../schemas/redemption.ts";

export const redemptions = {
  list: oc
    .meta(mcpMeta({ expose: true, riskLevel: "safe" }))
    .route({ method: "GET", path: "/redemptions", summary: "List redemptions" })
    .input(
      paginationInput.extend({
        search: z.string().optional(),
        result: redemptionResult.optional(),
        campaignId: z.string().uuid().optional(),
        voucherId: z.string().uuid().optional(),
      }),
    )
    .output(paginatedOutput(redemptionOutput)),
};