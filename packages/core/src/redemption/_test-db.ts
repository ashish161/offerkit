import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schema, type Db } from "@offerkit/db";
import { createPgliteTestDb, isPgliteTest } from "@offerkit/db/test-pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "..", "..", "..", "db", "drizzle");

export interface TestDbHandle {
  db: Db;
  close: () => Promise<void>;
}

let cached: Promise<TestDbHandle> | null = null;

/**
 * Live-DB suites enable with TEST_DATABASE_URL / DATABASE_URL (Postgres)
 * or OFFERKIT_TEST_PGLITE=1 (in-memory). Prefer a real URL when both are set.
 */
export function isLiveDbEnabled(): boolean {
  return Boolean(process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"]) || isPgliteTest();
}

/**
 * Lazily migrates the target DB once per worker, then hands the same Db
 * back to every caller. Two test files running in parallel would otherwise
 * race on schema creation.
 */
export function getTestDb(url?: string): Promise<TestDbHandle> {
  if (cached) return cached;
  const resolved = url ?? process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  cached = (async () => {
    if (resolved) {
      const pool = new Pool({ connectionString: resolved });
      const migrator = drizzle(pool);
      await migrate(migrator, { migrationsFolder });
      const db = drizzle(pool, { schema, casing: "snake_case" });
      return {
        db,
        close: async () => {
          await pool.end();
        },
      };
    }
    if (!isPgliteTest()) {
      throw new Error("getTestDb: set TEST_DATABASE_URL or OFFERKIT_TEST_PGLITE=1");
    }
    return createPgliteTestDb(migrationsFolder);
  })();
  return cached;
}
