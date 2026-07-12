import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassChallenge, canvassChallengeParticipant, canvassKnock, canvassSpiff } from "../src/index";
import { withTenant } from "../src/tenant";
import { createChallenge, acceptChallenge, settleDueChallenges } from "../src/lifecycle/canvass-challenge";
import { createManualSpiff, listSpiffs, markSpiffPaid } from "../src/lifecycle/canvass-spiff";

let tId: string, repA: string, repB: string, repC: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Spiff Co", publicKey: `sp-${Date.now()}`, clerkOrgId: `org_sp_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Rep A", pinHash: "x" },
    { tenantId: tId, name: "Rep B", pinHash: "x" },
    { tenantId: tId, name: "Rep C", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id; repC = reps[2]!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassSpiff).where(eq(canvassSpiff.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassChallengeParticipant).where(eq(canvassChallengeParticipant.tenantId, tId));
  await adminDb.delete(canvassChallenge).where(eq(canvassChallenge.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

// window fully in the past so it settles immediately
const past = () => {
  const end = new Date(Date.now() - 3_600_000);
  const start = new Date(end.getTime() - 86_400_000);
  return { start, end, mid: new Date(start.getTime() + 43_200_000) };
};
const knock = (repId: string, outcome: string, at: Date) => ({
  tenantId: tId, repId, clientId: `k-${repId}-${at.getTime()}-${Math.round(at.getTime() % 1000)}`,
  lat: 33.4, lng: -111.8, outcome, gpsFlagged: false, createdAt: at,
});

describe("manual spiff + mark paid", () => {
  it("creates an owed manual spiff and flips it to paid", async () => {
    const { id } = await withTenant(tId, (tx) => createManualSpiff(tx, { tenantId: tId, winnerRepId: repA, amountCents: 5000, note: "Fastest 10 doors" }));
    const owed = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    expect(owed.find((s) => s.id === id)?.status).toBe("owed");
    const flipped = await withTenant(tId, (tx) => markSpiffPaid(tx, tId, id, new Date()));
    expect(flipped).toBe(true);
    const after = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const row = after.find((s) => s.id === id)!;
    expect(row.status).toBe("paid");
    expect(row.settledAt).not.toBeNull();
    // re-marking a paid row is a no-op
    expect(await withTenant(tId, (tx) => markSpiffPaid(tx, tId, id, new Date()))).toBe(false);
  });
});

describe("wager spiff on h2h settlement", () => {
  it("loser owes winner the wager when the challenge settles", async () => {
    // clear knocks so this test's window can't pick up rows from other tests
    // (all settlement tests use overlapping past() windows on the same reps)
    await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
    const { start, end, mid } = past();
    const { id: chId } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repA, kind: "h2h", metric: "doors",
      windowStart: start, windowEnd: end, participantRepIds: [repA, repB], meta: { wagerCents: 2000 },
    }));
    // h2h stays "pending" until the opponent accepts — settleDueChallenges only
    // settles "active" challenges, so repB must accept before the window closes.
    await withTenant(tId, (tx) => acceptChallenge(tx, tId, chId, repB));
    // A gets 2 doors, B gets 1 — inside the window
    await withTenant(tId, async (tx) => {
      await tx.insert(canvassKnock).values([
        knock(repA, "noanswer", mid), knock(repA, "callback", new Date(mid.getTime() + 1000)),
        knock(repB, "noanswer", mid),
      ]);
    });
    const settled = await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    expect(settled).toBeGreaterThanOrEqual(1);
    const spiffs = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const wager = spiffs.find((s) => s.challengeId === chId && s.kind === "wager");
    expect(wager).toBeTruthy();
    expect(wager!.amountCents).toBe(2000);
    expect(wager!.winnerRepId).toBe(repA);
    expect(wager!.fromRepId).toBe(repB);
    expect(wager!.status).toBe("owed");
  });
});

describe("contest prize spiff on settlement", () => {
  it("pool goes to the winner, from null", async () => {
    // clear knocks first — the h2h test above left repA knocks inside this
    // window, which would tie repC's contest score and null the winner
    await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
    const { start, end, mid } = past();
    const { id: chId } = await withTenant(tId, (tx) => createChallenge(tx, {
      tenantId: tId, createdByRepId: repC, kind: "contest", metric: "doors",
      windowStart: start, windowEnd: end, participantRepIds: [repA, repB, repC], meta: { prizePoolCents: 10000 },
    }));
    await withTenant(tId, async (tx) => {
      await tx.insert(canvassKnock).values([
        knock(repC, "noanswer", mid), knock(repC, "noanswer", new Date(mid.getTime() + 1000)), knock(repC, "noanswer", new Date(mid.getTime() + 2000)),
        knock(repA, "noanswer", mid),
      ]);
    });
    await withTenant(tId, (tx) => settleDueChallenges(tx, tId, new Date()));
    const spiffs = await withTenant(tId, (tx) => listSpiffs(tx, tId, "all"));
    const prize = spiffs.find((s) => s.challengeId === chId && s.kind === "contest_prize");
    expect(prize).toBeTruthy();
    expect(prize!.amountCents).toBe(10000);
    expect(prize!.winnerRepId).toBe(repC);
    expect(prize!.fromRepId).toBeNull();
  });
});

describe("listSpiffs scope=mine", () => {
  it("returns only rows where the rep is winner or payer", async () => {
    const mine = await withTenant(tId, (tx) => listSpiffs(tx, tId, "mine", repB));
    // repB should see the h2h wager (as payer) but not repA's manual spiff
    expect(mine.every((s) => s.winnerRepId === repB || s.fromRepId === repB)).toBe(true);
    expect(mine.some((s) => s.kind === "wager" && s.fromRepId === repB)).toBe(true);
  });
});
