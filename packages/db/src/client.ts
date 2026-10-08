import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.ts";

let pool: Pool | undefined;
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
/** Test-only override (e.g. in-memory PGlite). Takes precedence over Pool cache. */
let testDbOverride: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (testDbOverride) return testDbOverride;
  if (cachedDb) return cachedDb;
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  pool = new Pool({ connectionString: url });
  cachedDb = drizzle(pool, { schema, casing: "snake_case" });
  return cachedDb;
}

/**
 * Point `getDb()` at a test database (PGlite or otherwise). Pass `undefined`
 * to clear. Used by live-DB Vitest suites so routers share the same handle.
 */
export function setTestDbOverride(db: Db | undefined): void {
  testDbOverride = db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    cachedDb = undefined;
  }
}

export type Db = ReturnType<typeof getDb>;
