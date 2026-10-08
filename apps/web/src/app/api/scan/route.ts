import { handleScan } from "@/server/qr-loyalty/scan";

export async function POST(request: Request): Promise<Response> {
  return handleScan(request);
}
