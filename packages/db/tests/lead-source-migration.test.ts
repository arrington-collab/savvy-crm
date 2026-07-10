import { describe, it, expect } from "vitest";
import { adminDb, lead, referralPayment, eq, sql } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeJobWithProperty } from "./helpers.js";
import { LEAD_SOURCE_VALUES } from "@savvy/core";

describe("Slice 3 schema + legacy mapping", () => {
  it("round-trips source + source_detail", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    await adminDb.update(lead).set({ source: "referral", sourceDetail: { referrer_name: "Sue" } }).where(eq(lead.id, leadId));
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.source).toBe("referral");
    expect((l!.sourceDetail as { referrer_name: string }).referrer_name).toBe("Sue");
  });

  it("remaps every legacy source value to the enum, tenant-scoped, per migration 0072", async () => {
    const { tenantId } = await makeTenant();

    // Seed one lead per legacy source value covered by migration 0072, plus a
    // null source and an unknown/legacy value that should hit the catch-all.
    const legacyValues = [
      "web",
      "door-knocking",
      "inbound-call",
      "after-hours-voicemail",
      "google",
      "facebook",
      "carrier",
      "yard_sign",
      "repeat",
      null,
      "trade_show_2024",
    ] as const;

    const leadIds: Record<string, string> = {};
    for (const value of legacyValues) {
      const { leadId } = await makeLeadWithProperty(tenantId);
      await adminDb.update(lead).set({ source: value }).where(eq(lead.id, leadId));
      leadIds[value ?? "__null__"] = leadId;
    }

    // Same CASE/UPDATE logic as packages/db/drizzle/0072_wet_true_believers.sql,
    // scoped to this tenant only so it can't touch rows from other tests/worktrees.
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'web' WHERE (source IN ('web','website','seed','e2e','test') OR source IS NULL) AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'canvass' WHERE source IN ('door-knocking','door_knock','storm_canvass') AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'inbound_call' WHERE source = 'inbound-call' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'inbound_call', source_detail = '{"note":"after-hours voicemail"}'::jsonb WHERE source = 'after-hours-voicemail' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"google_ads"}'::jsonb WHERE source = 'google' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'ads', source_detail = '{"platform":"meta"}'::jsonb WHERE source = 'facebook' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'insurance_agent' WHERE source = 'carrier' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'other', source_detail = '{"note":"yard sign"}'::jsonb WHERE source = 'yard_sign' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source = 'other', source_detail = '{"note":"repeat customer"}'::jsonb WHERE source = 'repeat' AND tenant_id = ${tenantId}`,
    );
    await adminDb.execute(
      sql`UPDATE "lead" SET source_detail = jsonb_build_object('custom_label', source), source = 'other'
            WHERE source <> ALL (${sql.raw(`ARRAY[${LEAD_SOURCE_VALUES.map((v) => `'${v}'`).join(",")}]`)})
              AND tenant_id = ${tenantId}`,
    );

    const rows = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const get = (key: string) => byId.get(leadIds[key]!)!;

    expect(get("web").source).toBe("web");
    expect(get("door-knocking").source).toBe("canvass");
    expect(get("inbound-call").source).toBe("inbound_call");
    expect(get("after-hours-voicemail").source).toBe("inbound_call");
    expect(get("after-hours-voicemail").sourceDetail).toEqual({ note: "after-hours voicemail" });
    expect(get("google").source).toBe("ads");
    expect(get("google").sourceDetail).toEqual({ platform: "google_ads" });
    expect(get("facebook").source).toBe("ads");
    expect(get("facebook").sourceDetail).toEqual({ platform: "meta" });
    expect(get("carrier").source).toBe("insurance_agent");
    expect(get("yard_sign").source).toBe("other");
    expect(get("yard_sign").sourceDetail).toEqual({ note: "yard sign" });
    expect(get("repeat").source).toBe("other");
    expect(get("repeat").sourceDetail).toEqual({ note: "repeat customer" });
    expect(get("__null__").source).toBe("web");
    expect(get("trade_show_2024").source).toBe("other");
    expect(get("trade_show_2024").sourceDetail).toEqual({ custom_label: "trade_show_2024" });

    // Every remapped source now lands in the enum.
    for (const r of rows) {
      expect(LEAD_SOURCE_VALUES as readonly string[]).toContain(r.source);
    }
  });

  it("referral_payment enforces one row per (tenant, job)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { jobId } = await makeJobWithProperty(tenantId);
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" });
    await adminDb.insert(referralPayment).values({ tenantId, jobId, leadId, payeeName: "Sue", amountCents: 10000, status: "approved" }).onConflictDoNothing();
    const all = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(all).toHaveLength(1);
  });
});
