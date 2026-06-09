import { adminDb, adminPool } from "./admin-client";
import { tenant, user, customer, property, job } from "./schema/index";

async function seedTenant(opts: {
  name: string; clerkOrgId: string; publicKey: string; inboundPhone: string;
}) {
  const [t] = await adminDb.insert(tenant).values({
    name: opts.name, revenueBand: "1-5M", planPrice: "999",
    clerkOrgId: opts.clerkOrgId, publicKey: opts.publicKey, inboundPhone: opts.inboundPhone,
  }).returning();

  await adminDb.insert(user).values([
    { tenantId: t!.id, name: "Owner", email: `owner@${opts.publicKey}.test`, role: "owner" },
    { tenantId: t!.id, name: "Rep", email: `rep@${opts.publicKey}.test`, role: "rep" },
  ]);

  const [c] = await adminDb.insert(customer).values({
    tenantId: t!.id, name: "Jane Homeowner", email: "jane@example.com", phone: "+15555550100",
  }).returning();

  const [p] = await adminDb.insert(property).values({
    tenantId: t!.id, customerId: c!.id, address: "123 Main St", roofSqft: 2400, stories: 1,
  }).returning();

  // a few jobs across stages so the pipeline has data
  const stages = ["lead", "inspected", "estimate", "approved", "production"] as const;
  for (const stage of stages) {
    await adminDb.insert(job).values({
      tenantId: t!.id, customerId: c!.id, propertyId: p!.id,
      type: "retail", stage, valueEstimate: 1500000,
    });
  }
  return t;
}

async function main() {
  await seedTenant({ name: "Acme Roofing", clerkOrgId: "org_acme", publicKey: "acme", inboundPhone: "+15555550111" });
  await seedTenant({ name: "Best Roofers", clerkOrgId: "org_best", publicKey: "best", inboundPhone: "+15555550222" });
  console.log("seeded 2 tenants");
  await adminPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
