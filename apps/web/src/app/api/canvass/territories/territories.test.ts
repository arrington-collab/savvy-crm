/**
 * Auth-gate unit tests for POST /api/canvass/territories.
 *
 * GET (field read via ?key=) stays public-key accessible — only the POST
 * (create territory) is hardened to require org-admin session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks (must precede route import) ──────────────────────────────────────
vi.mock("@/lib/tenant", () => ({ getTenantId: vi.fn() }));
vi.mock("@/lib/authz", () => ({ isOrgAdmin: vi.fn() }));
vi.mock("@/lib/canvass-cors", () => ({ canvassCors: () => new Headers() }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/intake", () => ({ tenantByKey: vi.fn() }));
vi.mock("@/lib/canvass-session", () => ({
  verifyCanvassToken: vi.fn(() => null),
  bearerToken: vi.fn(() => null),
}));
vi.mock("@savvy/db", () => ({
  withTenant: vi.fn(async (_tid: string, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => [{ id: "terr-001" }]) })) })),
      select: vi.fn(() => ({ from: vi.fn(() => []) })),
    };
    return fn(tx);
  }),
  canvassTerritory: {},
}));
vi.mock("server-only", () => ({}));

import { getTenantId } from "@/lib/tenant";
import { isOrgAdmin } from "@/lib/authz";
import { POST } from "./route";

const TENANT_ID = "tenant-xyz";
const mockGetTenantId = vi.mocked(getTenantId);
const mockIsOrgAdmin = vi.mocked(isOrgAdmin);

const VALID_TERRITORY = {
  clientId: "terr-client-1",
  name: "North District",
  color: "#ff0000",
  points: [[33.4, -111.8], [33.5, -111.8], [33.5, -111.9]],
};

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/canvass/territories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/canvass/territories — auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when there is no authenticated session (getTenantId throws)", async () => {
    mockGetTenantId.mockRejectedValue(new Error("no active organization"));
    const res = await POST(makeRequest(VALID_TERRITORY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 403 when authenticated but not an org-admin", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(false);
    const res = await POST(makeRequest(VALID_TERRITORY));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("returns 400 for a territory with fewer than 3 points", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(true);
    const bad = { ...VALID_TERRITORY, points: [[33.4, -111.8], [33.5, -111.8]] };
    const res = await POST(makeRequest(bad));
    expect(res.status).toBe(400);
  });

  it("succeeds (201) for an org-admin with a valid territory", async () => {
    mockGetTenantId.mockResolvedValue(TENANT_ID);
    mockIsOrgAdmin.mockResolvedValue(true);
    const res = await POST(makeRequest(VALID_TERRITORY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
