import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassScan, canvassPing } from "../src/index";
import { withTenant } from "../src/tenant";
import { createScan, listScans } from "../src/lifecycle/canvass-scan";
import { insertPings, listPingsForDay } from "../src/lifecycle/canvass-ping";

let tId: string, repA: string, repB: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Scan Co", publicKey: `sc-${Date.now()}`, clerkOrgId: `org_sc_${Date.now()}`, timezone: "America/Phoenix" }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Rep A", pinHash: "x" }, { tenantId: tId, name: "Rep B", pinHash: "x" },
  ]).returning();
  repA = reps[0]!.id; repB = reps[1]!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassPing).where(eq(canvassPing.tenantId, tId));
  await adminDb.delete(canvassScan).where(eq(canvassScan.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end(); await adminPool.end();
});

describe("scans", () => {
  it("creates with ack stamping and lists newest-first with rep name", async () => {
    await withTenant(tId, (tx) => createScan(tx, { tenantId: tId, repId: repA, name: "Jane HO", phone: "480-555-1111", ack: true }));
    await withTenant(tId, (tx) => createScan(tx, { tenantId: tId, repId: repB, name: "Bob HO", ack: false }));
    const scans = await withTenant(tId, (tx) => listScans(tx, tId));
    expect(scans.length).toBe(2);
    expect(scans[0]!.name).toBe("Bob HO"); // newest first
    expect(scans[0]!.repName).toBe("Rep B");
    const jane = scans.find((s) => s.name === "Jane HO")!;
    expect(jane.ack).toBe(true);
    const [raw] = await adminDb.select().from(canvassScan).where(eq(canvassScan.id, jane.id));
    expect(raw!.ackAt).not.toBeNull();
  });
});

describe("pings", () => {
  it("clamps batches, buckets by tenant-local day, groups per rep in time order", async () => {
    const base = Date.parse("2026-07-13T20:00:00.000Z"); // 1pm Phoenix
    const n = await withTenant(tId, (tx) => insertPings(tx, tId, repA, [
      { lat: 33.40, lng: -111.80, ts: base }, { lat: 33.41, lng: -111.81, ts: base + 60000 },
      { lat: NaN as unknown as number, lng: 0, ts: base }, // dropped
    ]));
    expect(n).toBe(2);
    await withTenant(tId, (tx) => insertPings(tx, tId, repB, [{ lat: 33.50, lng: -111.90, ts: base + 120000 }]));
    const day = await withTenant(tId, (tx) => listPingsForDay(tx, tId, "America/Phoenix", "2026-07-13"));
    expect(day.length).toBe(2);
    const a = day.find((d) => d.repId === repA)!;
    expect(a.points.length).toBe(2);
    expect(a.points[0]![2]).toBeLessThan(a.points[1]![2]); // time-ordered
    // outside the local day → excluded
    const other = await withTenant(tId, (tx) => listPingsForDay(tx, tId, "America/Phoenix", "2026-07-12"));
    expect(other.find((d) => d.repId === repA)).toBeUndefined();
  });
});
