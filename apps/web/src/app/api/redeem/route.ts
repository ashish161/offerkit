import { handleRedeem } from "@/server/qr-loyalty/redeem";

/**
 * POST /api/redeem — merchant terminal redemption. Guarded by the same
 * brand + PIN gate as /api/scan.
 */
export async function POST(request: Request): Promise<Response> {
  return handleRedeem(request);
}
