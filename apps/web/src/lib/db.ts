import { getDb as getRawDb, type Db } from "@offerkit/db";

let cached: Db | undefined;

export function db(): Db {
  cached ??= getRawDb();
  return cached;
}

/** Clear the web-layer cache so the next `db()` picks up `setTestDbOverride`. */
export function resetDbCache(): void {
  cached = undefined;
}
