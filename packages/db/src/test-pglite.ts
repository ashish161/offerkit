import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema/index.ts";
import type { Db } from "./client.ts";

/**
 * Opt-in for CI / local runs that should exercise live-DB suites without
 * a real Postgres. Prefer TEST_DATABASE_URL when set (real Postgres).
 */
export function isPgliteTest(): boolean {
  const raw = process.env["OFFERKIT_TEST_PGLITE"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export interface PgliteTestDbHandle {
  db: Db;
  close: () => Promise<void>;
}

const defaultMigrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/**
 * In-memory PGlite + Drizzle, migrated with the package SQL migrations.
 * The returned `db` is cast to the production `Db` type — query APIs used
 * by routers/core match; lock semantics are not identical to Postgres.
 */
export async function createPgliteTestDb(
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<PgliteTestDbHandle> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema, casing: "snake_case" });
  await migrate(pgliteDb, { migrationsFolder });
  return {
    db: pgliteDb as unknown as Db,
    close: async () => {
      await client.close();
    },
  };
}
