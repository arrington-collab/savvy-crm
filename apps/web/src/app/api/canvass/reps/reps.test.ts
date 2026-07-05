/**
 * Auth-gate unit tests for /api/canvass/reps (PATCH).
 *
 * The POST auth gate is the canonical pattern from #139 — these tests mirror it
 * for the new PATCH (deactivate/reactivate) handler.
 *
 * Dependencies that require Clerk / DB are vi.mock'd so tests run without
 * a live DB or Clerk session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks (must precede route import) ──────────────────────────────────────
vi.mock("@/lib/tenant", () => ({ getTenantId: vi.fn() }));
vi.mock("@/lib/authz", () => ({ isOrgAdmin: vi.fn() }));
vi.mock("@/lib/canvass-cors", () => ({ canvassCors: () => new Headers() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })), clientIp: () => "127.0.0.1" }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/intake", () => ({ tenantByKey: vi.fn() }));
vi.mock("@savvy/db", () => ({
  adminDb: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => [{ id: "rep-123", name: "Alex", photoUrl: null }]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => [{ id: "rep-123", active: false }]) })) })) })),
  },
  canvassRep: {},
  and: vi.fn((...a: unknown[]) => a),
  eq: vi.fn(() => true),
  sql: vi.fn(),
}));
// server-only guard
vi.mock("server-only", () => ({}));

import { getTenantId } from "@/lib/tenant";
import { isOrgAdmin } from "@/lib/authz";
import { PATCH } from "./route";

const TENANT_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const REP_ID = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const mockGetTenantId = vi.mocked(getTenantId);
const mockIsOrgAdmin = vi.mocked(isOrgAdmin);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/canvass/reps", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/canvass/reps — auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when there is no authenticated session (getTenantId throws)", async () => {
    mockGetTenantId.mockRejectedValue(new Error("no active organization"));
    const res = await PATCH(makeRequest({ repId: REP_ID, active: false }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 403 when authenticated but not an org-admin", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(false);
    const res = await PATCH(makeRequest({ repId: REP_ID, active: false }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("returns 400 for a missing repId", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(true);
    const res = await PATCH(makeRequest({ active: false })); // no repId
    expect(res.status).toBe(400);
  });

  it("succeeds (200) for an org-admin with a valid payload", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(true);
    const res = await PATCH(makeRequest({ repId: REP_ID, active: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
