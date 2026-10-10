import { parseBrands, listBrandNames } from "@/server/qr-loyalty/brands";

export async function GET(): Promise<Response> {
  const brands = parseBrands(process.env.MULTI_TENANT_BRANDS);
  return Response.json({ brands: listBrandNames(brands) });
}
