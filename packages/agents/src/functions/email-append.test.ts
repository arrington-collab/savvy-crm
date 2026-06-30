import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, eq } from "@savvy/db";
import { makeFakeEmailFinder, makeDormantEmailFinder } from "@savvy/integrations";
import { appendEmailsForTenant } from "./email-append";

async function seedTenant(): Promise<string> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "EA", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  return t!.id;
}

describe("appendEmailsForTenant", () => {
  it("fills an emailless customer (with phone) via the finder, tagged appended", async () => {
    const tenantId = await seedTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Phone Pat", phone: "+16025550000" }).returning();
    expect(await appendEmailsForTenant(tenantId, makeFakeEmailFinder("found@x.com"), 50)).toBe(1);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(customer).where(eq(customer.id, c!.id)));
    expect(row!.email).toBe("found@x.com");
    expect(row!.emailSource).toBe("appended");
  });

  it("writes nothing with the dormant finder (inert)", async () => {
    const tenantId = await seedTenant();
    await adminDb.insert(customer).values({ tenantId, name: "Phone Pat", phone: "+16025550000" });
    expect(await appendEmailsForTenant(tenantId, makeDormantEmailFinder(), 50)).toBe(0);
  });
});
