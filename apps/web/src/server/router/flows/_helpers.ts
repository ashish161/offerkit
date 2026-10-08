import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodSmartCoercionPlugin } from "@orpc/zod";
import { schema, setTestDbOverride, type Db } from "@offerkit/db";
import { createPgliteTestDb, isPgliteTest } from "@offerkit/db/test-pglite";
import { createClient, type Client } from "@offerkit/sdk";
import { mintApiKey } from "@/lib/api-key";
import { resetDbCache } from "@/lib/db";
import { router } from "../index";

// Shared scaffolding for SDK round-trip e2e tests under flows/.
// Each test file imports getTestDb to lazily migrate a target Postgres
// (or in-memory PGlite) once per test process, mintTestKey to insert a
// scoped API key, and makeClient to build a typed @offerkit/sdk client
// backed by a fake fetch that drives the live oRPC handler in-process.
//
// Enable with either:
//   TEST_DATABASE_URL / DATABASE_URL  → real Postgres
//   OFFERKIT_TEST_PGLITE=1            → in-memory PGlite (CI)
// Without either, suites skip so default `pnpm -r test` stays infra-free.

export const TEST_DB_URL = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const E2E_ENABLED = Boolean(TEST_DB_URL) || isPgliteTest();
/** True when using in-memory PGlite with no real Postgres URL. */
export const PGLITE_ONLY = isPgliteTest() && !TEST_DB_URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "drizzle",
);

interface TestDbHandle {
  db: Db;
  close: () => Promise<void>;
}

let cached: Promise<TestDbHandle> | null = null;

function seedTestSecrets(): void {
  // Better Auth needs the secret to mint hashes for password rows we
  // never use; the api-key.ts helper also reads it as the HMAC pepper.
  process.env["BETTER_AUTH_SECRET"] ??= "test-secret-1234567890123456789012";
  process.env["WEBHOOK_SECRET_ENCRYPTION_KEY"] ??=
    "test-webhook-encryption-key-with-at-least-32-characters";
}

/**
 * Lazily migrates the target DB once per test process and hands the
 * same Db back to every caller. Two test files running in sequence
 * (we set fileParallelism: false on the vitest config) reuse the same
 * handle and avoid re-running migrations.
 *
 * When using PGlite, also overrides `@offerkit/db` `getDb()` so routers
 * share the in-memory instance (there is no connection URL to share).
 */
export function getTestDb(url: string | undefined = TEST_DB_URL): Promise<TestDbHandle> {
  if (cached) return cached;
  seedTestSecrets();
  cached = (async () => {
    if (url) {
      process.env["DATABASE_URL"] = url;
      const pool = new Pool({ connectionString: url });
      const migrator = drizzle(pool);
      await migrate(migrator, { migrationsFolder });
      const db = drizzle(pool, { schema, casing: "snake_case" });
      setTestDbOverride(db);
      resetDbCache();
      return {
        db,
        close: async () => {
          setTestDbOverride(undefined);
          resetDbCache();
          await pool.end();
        },
      };
    }
    if (!isPgliteTest()) {
      throw new Error("getTestDb: set TEST_DATABASE_URL or OFFERKIT_TEST_PGLITE=1");
    }
    const handle = await createPgliteTestDb(migrationsFolder);
    setTestDbOverride(handle.db);
    resetDbCache();
    return {
      db: handle.db,
      close: async () => {
        setTestDbOverride(undefined);
        resetDbCache();
        await handle.close();
      },
    };
  })();
  return cached;
}

export interface MintedTestKey {
  token: string;
  prefix: string;
}

export async function mintTestKey(
  db: Db,
  scopes: string[] = ["*"],
  rateLimitRps = 10_000,
): Promise<MintedTestKey> {
  const minted = mintApiKey();
  await db
    .insert(schema.apiKey)
    .values({
      id: `key_${minted.prefix}`,
      name: "e2e test",
      prefix: minted.prefix,
      hashedSecret: minted.hashedSecret,
      scopes,
      rateLimitRps,
    })
    .onConflictDoNothing();
  return { token: minted.token, prefix: minted.prefix };
}

export async function deleteTestKey(db: Db, prefix: string): Promise<void> {
  await db.delete(schema.apiKey).where(eq(schema.apiKey.prefix, prefix));
}

const sharedHandler = new OpenAPIHandler(router, {
  plugins: [new ZodSmartCoercionPlugin()],
});

/**
 * Build a typed @offerkit/sdk client wired to a fake fetch that drives
 * the live oRPC handler in-process. Forwards Request body + headers
 * (notably Authorization) so the authenticated path is exercised
 * end-to-end.
 */
export function makeClient(token: string): Client {
  const fakeFetch: typeof fetch = async (input, init) => {
    const req =
      input instanceof Request
        ? init
          ? new Request(input, init)
          : input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    const { response } = await sharedHandler.handle(req, {
      prefix: "/api/v1",
      context: { request: req, headers: req.headers },
    });
    return response ?? new Response("not found", { status: 404 });
  };
  return createClient({
    baseUrl: "http://test.local",
    apiKey: token,
    fetch: fakeFetch,
  });
}

let counter = 0;
export function randomId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}-${String(counter)}`;
}

/**
 * Send a raw Request to the oRPC handler. Use when you need to set a
 * header (e.g. `Idempotency-Key`) that the SDK doesn't expose.
 */
export async function rawRequest(req: Request): Promise<Response> {
  const { response } = await sharedHandler.handle(req, {
    prefix: "/api/v1",
    context: { request: req, headers: req.headers },
  });
  return response ?? new Response("not found", { status: 404 });
}
