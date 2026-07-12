import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassKnock, canvassChallenge, canvassChallengeParticipant } from "../src/index";
import { withTenant } from "../src/tenant";
import { createChallenge, acceptChallenge, standingsFor, settleDueChallenges, listChallenges } from "../src/lifecycle/canvass-challenge";

let tId: string, repA: string, repB: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CH", publicKey: `ch-${Date.now()}`, clerkOrgId: `org_ch_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "A", pinHash: "x" },
    { tenantId: tId, name: "B", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id;
  // A: 2 sales; B: 1 sale — timestamped to fall inside the test's challenge
  // window ([now-3600s, now-1s)), independent of exactly when this runs.
  const inWindow = new Date(Date.now() - 1800_000);
  await adminDb.insert(canvassKnock).values([
    { tenantId: tId, repId: repA, clientId: "a1", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: inWindow },
    { tenantId: tId, repId: repA, clientId: "a2", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: inWindow },
    { tenantId: tId, repId: repB, clientId: "b1", lat: 1, lng: 1, outcome: "sale", amount: 1000, createdAt: inWindow },
  ]);
});

afterAll(async () => {
  await adminDb.delete(canvassChallengeParticipant).where(eq(canvassChallengeParticipant.tenantId, tId));
  await adminDb.delete(canvassChallenge).where(eq(canvassChallenge.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end(); await adminPool.end();
});

describe("challenge lifecycle", () => {
  it("creates an h2h (pending until accepted), accepts it, computes live standings, and settles the winner", async () => {
    const winStart = new Date(Date.now() - 3600_000);
    const winEnd = new Date(Date.now() - 1000); // already past → settleable once active
    const { id } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repA, kind: "h2h", metric: "sales",
      windowStart: winStart, windowEnd: winEnd, participantRepIds: [repA, repB],
    }));
    expect(id).toBeTruthy();

    // pending until B accepts
    let list = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(list[0]!.status).toBe("pending");
    const ok = await withTenant(tId, (tx) => acceptChallenge(tx, tId, id, repB));
    expect(ok).toBe(true);
    list = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(list[0]!.status).toBe("active");

    // live standings: A (2 sales) over B (1 sale)
    const standings = await withTenant(tId, (tx) => standingsFor(tx, tId, list[0]!));
    expect(standings[0]!.repId).toBe(repA);
    expect(standings[0]!.score).toBe(2);

    // settle (window already ended)
    const n = await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    expect(n).toBe(1);
    const settled = await withTenant(tId, (tx) => listChallenges(tx, tId));
    expect(settled[0]!.status).toBe("settled");
    expect(settled[0]!.winnerRepId).toBe(repA);
  });
});
