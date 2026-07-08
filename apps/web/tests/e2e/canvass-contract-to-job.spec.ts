import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { signPayloadToken } from "@savvy/core";
import { adminDb, and, eq, tenant, canvassRep, lead, job, document } from "@savvy/db";

const { id: tenantId, key } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// Matches the webServer env (CANVASS_SESSION_SECRET unset → devFallback in canvass-session.ts).
const CANVASS_SECRET = "dev-canvass-secret";

test("canvass signed contract → lead won + job with rescission hold + contract carried", async ({ request }) => {
  const stamp = randomUUID().slice(0, 8);
  const [rep] = await adminDb.insert(canvassRep).values({ tenantId, name: "Marcus R.", pinHash: "x" }).returning();
  const token = signPayloadToken({ tenantId, repId: rep!.id, exp: String(Date.now() + 3_600_000) }, CANVASS_SECRET);

  const body = {
    key,
    customer: { name: `E2E Test HO ${stamp}`, phone: `+1555${String(Date.now()).slice(-7)}`, address: `${stamp} Canvass Way, Mesa AZ 85203` },
    contract: {
      kind: "retail",
      document: "Roofing Agreement",
      fields: {},
      scopeItems: [],
      rep: "Marcus R.",
      signedAt: "2026-07-04T21:00:00.000Z", // 14:00 America/Phoenix
      consentElectronic: true,
      // 64 hex chars, unique per run (stamp is hex from randomUUID).
      integrityHash: (stamp + "0".repeat(64)).slice(0, 64),
      signaturePng: "data:image/png;base64,iVBORw0KGgo=",
    },
  };

  const res = await request.post("/api/canvass/contract", {
    data: body,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { leadId } = (await res.json()) as { leadId: string };
  expect(leadId).toBeTruthy();

  // The durable workflow stores the contract, converts the lead, and stamps the hold.
  let jobRow: typeof job.$inferSelect | undefined;
  for (let i = 0; i < 20 && !jobRow; i++) {
    await new Promise((r) => setTimeout(r, 500));
    [jobRow] = await adminDb.select().from(job).where(eq(job.leadId, leadId));
  }
  expect(jobRow, "job should be created from the signed contract").toBeTruthy();

  const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
  expect(l!.status).toBe("won");
  expect(jobRow!.canvassRepName).toBe("Marcus R.");
  // AZ default 3 days? The e2e tenant property has no state → fallback 3 days from 2026-07-04.
  expect(jobRow!.rescissionHoldUntil).toBeTruthy();

  // The contract document is lead-scoped and carried onto the job.
  const docs = await adminDb.select().from(document).where(and(eq(document.leadId, leadId), eq(document.kind, "contract")));
  expect(docs.length).toBeGreaterThanOrEqual(1);
  expect(docs[0]!.jobId).toBe(jobRow!.id);
});
