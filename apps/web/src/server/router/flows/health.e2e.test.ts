import { beforeAll, describe, expect, it } from "vitest";
import { E2E_ENABLED, getTestDb, rawRequest } from "./_helpers";

describe("health and readiness probes", () => {
  beforeAll(async () => {
    // When live DB is enabled (Postgres URL or PGlite), share the same
    // handle so `/ready` sees a working `getDb()` override.
    if (E2E_ENABLED) await getTestDb();
  }, 30_000);

  it("returns liveness and database readiness through the public routes", async () => {
    const health = await rawRequest(new Request("http://test.local/api/v1/health"));
    expect(health.ok).toBe(true);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });

    const ready = await rawRequest(new Request("http://test.local/api/v1/ready"));
    expect(ready.ok).toBe(true);
    await expect(ready.json()).resolves.toMatchObject({
      status: E2E_ENABLED ? "ok" : "degraded",
      checks: { db: E2E_ENABLED, worker: true },
    });
  });
});
