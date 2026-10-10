export interface BrandConfig {
  programId: string;
  pin: string;
}

export interface BrandContext {
  brand: string;
  programId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function parseBrands(env?: string): Readonly<Record<string, BrandConfig>> {
  if (!env || env.trim() === "") return {} as Record<string, BrandConfig>;

  let parsed: unknown;
  try {
    parsed = JSON.parse(env);
  } catch {
    return {} as Record<string, BrandConfig>;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {} as Record<string, BrandConfig>;
  }

  const out: Record<string, BrandConfig> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.trim() === "") continue;
    if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const pid = typeof v.programId === "string" ? v.programId.trim() : "";
    const pin = typeof v.pin === "string" ? v.pin : "";
    if (!isUuid(pid)) continue;
    if (pin === "") continue;
    out[key.trim()] = { programId: pid, pin };
  }
  return out;
}

export function brandFromHeader(request: Request): string | null {
  const h = request.headers.get("x-brand") ?? request.headers.get("X-Brand");
  if (!h) return null;
  const t = h.trim();
  return t === "" ? null : t;
}

export function listBrandNames(brands: Readonly<Record<string, BrandConfig>>): string[] {
  return Object.keys(brands).sort((a, b) => a.localeCompare(b));
}
