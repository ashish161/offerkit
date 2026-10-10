import { db } from "@/lib/db";
import { loadBrands, parseBrands } from "@/server/qr-loyalty/brands";

/**
 * Tells the public /scan and /reports terminals whether this deployment is
 * multi-tenant (brand + PIN required). Deliberately does NOT return brand
 * names: brands must not be able to enumerate each other. A brand is told its
 * own name + PIN by an admin.
 */
export async function GET(): Promise<Response> {
  const dbBrands = await loadBrands(db());
  const multiTenant =
    dbBrands.length > 0 ||
    Object.keys(parseBrands(process.env.MULTI_TENANT_BRANDS)).length > 0;
  return Response.json({ multiTenant });
}
