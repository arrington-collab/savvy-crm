import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { customer, property, lead } from "../src/schema/crm";
import { job } from "../src/schema/jobs";
import { importRecord } from "../src/schema/import-record";
import { importAccuLynxData, type AccuLynxJobRecord, type AccuLynxContact } from "../src/lifecycle/acculynx-import";
import { makeTenant } from "./helpers";

const jobRec = (o: Partial<AccuLynxJobRecord> & { Id: string }): AccuLynxJobRecord => ({
  CurrentMilestone: "Invoiced",
  FullName: "Patrick Alland",
  FullAddress: "6705 East Louisiana Avenue, Denver, CO 80224",
  FullAddressGeoLocation: { lat: 39.6927509, lon: -104.9101129 },
  LeadSource: "Personal",
  SalesPerson: "Josh Wilkey",
  CreatedDate: "2026-02-19T01:02:35.11Z",
  OrderTotal: 10467.22,
  OrderPaid: 10467.22,
  WorkTypes: ["Retail"],
  PrimaryContact: {
    ContactID: "contact-guid-1", FullName: "Rebekah Scott",
    PrimaryPhone: "(303) 710-6874", PrimaryEmail: "rebekah.scott@realatlas.com",
  },
  ...o,
});

const contactRow = (o: Partial<AccuLynxContact> & { contactId: string }): AccuLynxContact => ({
  name: "Tawanda Crowell-Kennedy", phone: "(719) 453-9218",
  email: "tawandacrowell@gmail.com", address: "235 West Mill Street, Colorado Springs, CO 80904 US",
  ...o,
});

async function counts(tenantId: string) {
  const [customers, properties, leads, jobs] = await Promise.all([
    adminDb.select().from(customer).where(eq(customer.tenantId, tenantId)),
    adminDb.select().from(property).where(eq(property.tenantId, tenantId)),
    adminDb.select().from(lead).where(eq(lead.tenantId, tenantId)),
    adminDb.select().from(job).where(eq(job.tenantId, tenantId)),
  ]);
  return { customers, properties, leads, jobs };
}

describe("importAccuLynxData", () => {
  it("imports jobs at mapped stages, leads for Lead milestone, and contact-only customers", async () => {
    const { tenantId } = await makeTenant();
    const res = await importAccuLynxData(tenantId, {
      jobs: [
        jobRec({ Id: "j-1", CurrentMilestone: "Invoiced" }),
        jobRec({
          Id: "j-2", CurrentMilestone: "Dead", FullName: "Sue Personett",
          FullAddress: "18450 Pixie Park Road, Monument, CO 80132",
          PrimaryContact: { ContactID: "contact-guid-2", FullName: "Sue Personett", PrimaryPhone: "(719) 271-5168", PrimaryEmail: "shibuisue1@comcast.net" },
        }),
        jobRec({
          Id: "j-3", CurrentMilestone: "Lead", FullName: "Greg Levos",
          FullAddress: "4106 Morado Drive, Colorado Springs, CO 80916", LeadSource: "Referral",
          PrimaryContact: { ContactID: "contact-guid-3", FullName: "Greg Levos", PrimaryPhone: "(719) 217-5537", PrimaryEmail: "gslevos1949@msn.com" },
        }),
      ],
      contacts: [
        contactRow({ contactId: "contact-guid-1", name: "Rebekah Scott" }), // already imported via job
        contactRow({ contactId: "contact-guid-9" }), // job-less contact
      ],
    });

    expect(res).toMatchObject({ customers: 4, properties: 3, leads: 1, jobs: 2 });

    const c = await counts(tenantId);
    expect(c.customers).toHaveLength(4); // 3 job contacts + 1 contact-only
    expect(c.properties).toHaveLength(3);
    expect(c.leads).toHaveLength(1);
    expect(c.jobs).toHaveLength(2);

    const stages = c.jobs.map((j) => j.stage).sort();
    expect(stages).toEqual(["billing", "lost"]);

    // Geo + address made it onto the property.
    const denver = c.properties.find((p) => p.address.includes("Louisiana"))!;
    expect(denver.lat).toBeCloseTo(39.6927509);
    expect(denver.lng).toBeCloseTo(-104.9101129);

    // The lead carries the mapped source + original wording.
    expect(c.leads[0]!.source).toBe("referral");
    expect((c.leads[0]!.sourceDetail as { acculynx?: string })?.acculynx).toBe("Referral");

    // Every entity is traceable in the ledger with the raw payload.
    const ledger = await adminDb.select().from(importRecord)
      .where(and(eq(importRecord.tenantId, tenantId), eq(importRecord.source, "acculynx")));
    expect(ledger.length).toBe(res.customers + res.properties + res.leads + res.jobs);
    const jobLedger = ledger.find((r) => r.externalId === "job:j-1")!;
    expect((jobLedger.payload as { CurrentMilestone?: string }).CurrentMilestone).toBe("Invoiced");
  });

  it("is idempotent — a re-run creates nothing new", async () => {
    const { tenantId } = await makeTenant();
    const input = { jobs: [jobRec({ Id: "j-10" })], contacts: [contactRow({ contactId: "c-10" })] };

    await importAccuLynxData(tenantId, input);
    const second = await importAccuLynxData(tenantId, input);
    expect(second).toMatchObject({ customers: 0, properties: 0, leads: 0, jobs: 0 });

    const c = await counts(tenantId);
    expect(c.customers).toHaveLength(2);
    expect(c.properties).toHaveLength(1);
    expect(c.jobs).toHaveLength(1);
  });

  it("two jobs sharing a primary contact create ONE customer", async () => {
    const { tenantId } = await makeTenant();
    await importAccuLynxData(tenantId, {
      jobs: [
        jobRec({ Id: "j-20" }),
        jobRec({ Id: "j-21", FullAddress: "1 Other St, Denver, CO 80202" }),
      ],
      contacts: [],
    });
    const c = await counts(tenantId);
    expect(c.customers).toHaveLength(1);
    expect(c.jobs).toHaveLength(2);
    expect(c.properties).toHaveLength(2);
  });
});
