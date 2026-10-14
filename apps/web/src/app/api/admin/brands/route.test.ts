import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level guard tests for the admin brands REST surface. These requests are
// rejected by `requireAdminSession` (or by UUID/body validation) *before* any DB
// access, so `db()` is mocked to throw — a passing test proves the guard/validate
// short-circuits and no query leaks an unauthenticated caller into the database.
const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  auth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("@/lib/db", () => ({
  db: () => {
    throw new Error("db() must not be called for unauthenticated/invalid requests");
  },
}));

import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

const ADMIN = { user: { id: "admin-1", role: "admin" } };
const MEMBER = { user: { id: "member-1", role: "member" } };
const NO_ROLE = { user: { id: "user-1" } };

function req(method: string, body?: unknown): Request {
  return new Request("http://test.local/api/admin/brands", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/brands", () => {
  it("401 when there is no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("unauthorized");
  });

  it("403 for a signed-in member", async () => {
    mocks.getSession.mockResolvedValue(MEMBER);
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("403 when the role field is absent (defaults to member)", async () => {
    mocks.getSession.mockResolvedValue(NO_ROLE);
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/brands", () => {
  it("401 before parsing the body", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await POST(req("POST", { name: "A", programId: "x", pin: "1234" }));
    expect(res.status).toBe(401);
  });

  it("403 for a member", async () => {
    mocks.getSession.mockResolvedValue(MEMBER);
    const res = await POST(req("POST", {}));
    expect(res.status).toBe(403);
  });

  it("400 on an invalid body (admin passes the guard, validation rejects)", async () => {
    mocks.getSession.mockResolvedValue(ADMIN);
    const res = await POST(req("POST", { name: "", programId: "not-a-uuid", pin: "1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });
});

describe("PATCH /api/admin/brands/[id]", () => {
  it("401 when there is no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", { pin: "1234" }), params("not-a-uuid"));
    expect(res.status).toBe(401);
  });

  it("403 for a member", async () => {
    mocks.getSession.mockResolvedValue(MEMBER);
    const res = await PATCH(req("PATCH", { pin: "1234" }), params("not-a-uuid"));
    expect(res.status).toBe(403);
  });

  it("404 for a non-UUID id (admin) without touching the DB", async () => {
    mocks.getSession.mockResolvedValue(ADMIN);
    const res = await PATCH(req("PATCH", { pin: "1234" }), params("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("400 on an empty patch (admin)", async () => {
    mocks.getSession.mockResolvedValue(ADMIN);
    const res = await PATCH(
      req("PATCH", {}),
      params("11111111-1111-4111-8111-111111111111"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });
});

describe("DELETE /api/admin/brands/[id]", () => {
  it("401 when there is no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await DELETE(req("DELETE"), params("not-a-uuid"));
    expect(res.status).toBe(401);
  });

  it("403 for a member", async () => {
    mocks.getSession.mockResolvedValue(MEMBER);
    const res = await DELETE(req("DELETE"), params("not-a-uuid"));
    expect(res.status).toBe(403);
  });

  it("404 for a non-UUID id (admin)", async () => {
    mocks.getSession.mockResolvedValue(ADMIN);
    const res = await DELETE(req("DELETE"), params("not-a-uuid"));
    expect(res.status).toBe(404);
  });
});
