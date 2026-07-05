import { adminDb, adminPool } from "./admin-client";
import { tenant, user, customer, property, job, messageTemplate, drip, license } from "./schema/index";
import { parseSchedulingConfig } from "@savvy/core";
import { seedTaskRegistry } from "../seeds/master-task-list";

async function seedTenant(opts: {
  name: string; clerkOrgId: string; publicKey: string; inboundPhone: string;
}) {
  const [t] = await adminDb.insert(tenant).values({
    name: opts.name, revenueBand: "1-5M", planPrice: "999",
    clerkOrgId: opts.clerkOrgId, publicKey: opts.publicKey, inboundPhone: opts.inboundPhone,
    settings: { scheduling: parseSchedulingConfig(undefined) },
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
  // Phase 3: starter nurture templates + a 3-step drip (zero-delay steps so e2e
  // can trigger the first send immediately; real drips use real delays).
  await adminDb.insert(messageTemplate).values([
    { tenantId: t!.id, key: "nurture-sms-1", name: "Nurture · SMS day 0", channel: "sms",
      body: "Hi {{firstName}}, it's your roofing team — still thinking about that roof? Reply anytime." },
    { tenantId: t!.id, key: "nurture-email-1", name: "Nurture · Email day 2", channel: "email",
      subject: "Your roof inspection", body: "Hi {{firstName}}, here's how a free inspection works..." },
    { tenantId: t!.id, key: "nurture-sms-2", name: "Nurture · SMS day 5", channel: "sms",
      body: "Hi {{firstName}}, last nudge — want us to swing by this week?" },
  ]);
  await adminDb.insert(drip).values({
    tenantId: t!.id, key: "nurture", name: "New-lead nurture", triggerEvent: "lead/created", active: true,
    steps: [
      { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "nurture-sms-1" },
      { stepNum: 2, delayHours: 0, channel: "email", templateKey: "nurture-email-1" },
      { stepNum: 3, delayHours: 0, channel: "sms", templateKey: "nurture-sms-2" },
    ],
  });
  return t;
}

async function main() {
  const n = await seedTaskRegistry(adminDb);
  console.log(`seeded task_registry (${n} tasks)`);
  const demoTenant = await seedTenant({ name: "Acme Roofing", clerkOrgId: "org_acme", publicKey: "acme", inboundPhone: "+15555550111" });
  await seedTenant({ name: "Best Roofers", clerkOrgId: "org_best", publicKey: "best", inboundPhone: "+15555550222" });
  console.log("seeded 2 tenants");

  // Cell 17a: seed the demo tenant's operating-state licenses (AZ, NV, CO) so seeded
  // jobs are schedulable in each. city: null = state-level (covers all cities in state).
  // Clear before inserting so re-runs stay idempotent (license rows are pure seed data).
  await adminDb.delete(license);
  await adminDb.insert(license).values([
    { tenantId: demoTenant!.id, state: "AZ", city: null, authority: "AZ ROC",               licenseNumber: "ROC-DEMO-0001", status: "active", expiresAt: null },
    { tenantId: demoTenant!.id, state: "NV", city: null, authority: "NV State Contractors",  licenseNumber: "NV-DEMO-0001",  status: "active", expiresAt: null },
    { tenantId: demoTenant!.id, state: "CO", city: null, authority: "CO SoS",               licenseNumber: "CO-DEMO-0001",  status: "active", expiresAt: null },
  ]);
  console.log("seeded 3 demo licenses (AZ, NV, CO)");

  await adminPool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
