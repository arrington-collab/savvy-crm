/**
 * e2e: canvass manager-mutation auth gates.
 *
 * Verifies that the two org-admin-only canvass endpoints reject unauthenticated
 * callers with 401.  The tests use a fresh, sessionless request context so Clerk
 * finds no session cookie and getTenantId() throws — exactly the path exercised
 * by a rogue caller who skips the browser login flow.
 *
 *   PATCH /api/canvass/reps      → deactivate/reactivate a rep
 *   POST  /api/canvass/territories → create a territory
 *
 * GET /reps and GET /territories are intentionally public (field-device login
 * picker doesn't require an org session) and are NOT tested here.
 */
import { test, expect, request } from "@playwright/test";

test("PATCH /api/canvass/reps without session returns 401", async ({ baseURL }) => {
  const api = await request.newContext(); // no storageState → no Clerk session cookie
  const res = await api.patch(`${baseURL}/api/canvass/reps`, {
    data: { repId: "00000000-0000-0000-0000-000000000000", active: false },
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

test("POST /api/canvass/territories without session returns 401", async ({ baseURL }) => {
  const api = await request.newContext(); // no storageState → no Clerk session cookie
  const res = await api.post(`${baseURL}/api/canvass/territories`, {
    data: { name: "Test Zone", color: "#ff0000", points: [] },
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});
