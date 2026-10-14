import { handleListRewards } from "@/server/qr-loyalty/redeem";

/**
 * GET /api/rewards — rewards a terminal can redeem. Guarded by the same
 * brand + PIN gate as /api/scan.
 */
export async function GET(request: Request): Promise<Response> {
  return handleListRewards(request);
}
