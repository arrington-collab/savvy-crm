import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassKnock, canvassAlert } from "../src/index";
import { withTenant } from "../src/tenant";
import { createSaleNoContractAlerts, listAlerts, markAlertRead, markAllAlertsRead, readKnockForAlert } from "../src/lifecycle/canvass-alert";

let tId: string, seller: string, mgr: string, other: string, knockId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Alert Co", publicKey: `al-${Date.now()}`, clerkOrgId: `org_al_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb.insert(canvassRep).values([
    { tenantId: tId, name: "Seller", pinHash: "x" },
    { tenantId: tId, name: "Manager", pinHash: "x", manager: true },
    { tenantId: tId, name: "Other", pinHash: "x" },
  ]).returning();
  seller = reps[0]!.id; mgr = reps[1]!.id; other = reps[2]!.id;
  const [k] = await adminDb.insert(canvassKnock).values({ tenantId: tId, repId: seller, clientId: "sale-1", lat: 33.4, lng: -111.8, outcome: "sale", amount: 8000, contactName: "Jane HO", gpsFlagged: false }).returning();
  knockId = k!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassAlert).where(eq(canvassAlert.tenantId, tId));
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("createSaleNoContractAlerts", () => {
  it("writes one alert to the seller + each active manager, deduped, and is idempotent per knock", async () => {
    const { created } = await withTenant(tId, (tx) => createSaleNoContractAlerts(tx, tId, { knockId, sellerRepId: seller, contactLabel: "Jane HO" }));
    expect(created).toBe(2); // seller + manager (other is a plain rep, not notified)
    // seller and manager each see it; other sees nothing
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, seller))).alerts.length).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, mgr))).alerts.length).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, other))).alerts.length).toBe(0);
    // second call for the same knock writes nothing
    const again = await withTenant(tId, (tx) => createSaleNoContractAlerts(tx, tId, { knockId, sellerRepId: seller, contactLabel: "Jane HO" }));
    expect(again.created).toBe(0);
  });
});

describe("read state", () => {
  it("marks one alert read (owner only) and then all", async () => {
    const { alerts, unread } = await withTenant(tId, (tx) => listAlerts(tx, tId, seller));
    expect(unread).toBe(1);
    const aid = alerts[0]!.id;
    // a different rep cannot read the seller's alert
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, other, new Date()))).toBe(false);
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, seller, new Date()))).toBe(true);
    // re-marking is a no-op
    expect(await withTenant(tId, (tx) => markAlertRead(tx, tId, aid, seller, new Date()))).toBe(false);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, seller))).unread).toBe(0);
    // mark-all on the manager
    expect(await withTenant(tId, (tx) => markAllAlertsRead(tx, tId, mgr, new Date()))).toBe(1);
    expect((await withTenant(tId, (tx) => listAlerts(tx, tId, mgr))).unread).toBe(0);
  });
});

describe("readKnockForAlert", () => {
  it("returns the sale's outcome/contract state for the watcher", async () => {
    const k = await withTenant(tId, (tx) => readKnockForAlert(tx, knockId));
    expect(k?.outcome).toBe("sale");
    expect(k?.contractSignedAt).toBeNull();
    expect(k?.contactName).toBe("Jane HO");
  });
});
