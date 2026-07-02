import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { customer } from "../src/schema/index.js";
import { setCustomerEmail, findCustomersNeedingEmail } from "../src/lifecycle/customer.js";
import { makeTenant } from "./helpers.js";

async function mkCustomer(tenantId: string, values: Record<string, unknown>) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "T", ...values }).returning();
  return c!.id;
}
async function read(tenantId: string, id: string) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ email: customer.email, emailSource: customer.emailSource }).from(customer).where(eq(customer.id, id)));
  return row!;
}

describe("setCustomerEmail", () => {
  it("sets a self_reported email + source on an emailless customer", async () => {
    const { tenantId } = await makeTenant();
    const id = await mkCustomer(tenantId, { phone: "+16025550000" });
    expect(await setCustomerEmail(tenantId, { customerId: id, email: "home@x.com", source: "self_reported" })).toBe(true);
    expect(await read(tenantId, id)).toEqual({ email: "home@x.com", emailSource: "self_reported" });
  });

  it("appends an email only when none exists", async () => {
    const { tenantId } = await makeTenant();
    const id = await mkCustomer(tenantId, { phone: "+16025550000" });
    expect(await setCustomerEmail(tenantId, { customerId: id, email: "broker@x.com", source: "appended" })).toBe(true);
    expect((await read(tenantId, id)).emailSource).toBe("appended");
  });

  it("refuses to overwrite ANY existing email with an appended one", async () => {
    const { tenantId } = await makeTenant();
    const id = await mkCustomer(tenantId, { email: "real@x.com", emailSource: "self_reported" });
    expect(await setCustomerEmail(tenantId, { customerId: id, email: "broker@x.com", source: "appended" })).toBe(false);
    expect(await read(tenantId, id)).toEqual({ email: "real@x.com", emailSource: "self_reported" });
  });

  it("findCustomersNeedingEmail returns emailless customers that have a phone", async () => {
    const { tenantId } = await makeTenant();
    const withPhone = await mkCustomer(tenantId, { phone: "+16025550001" });
    const noPhone = await mkCustomer(tenantId, {});
    const hasEmail = await mkCustomer(tenantId, { phone: "+16025550002", email: "x@x.com" });
    const ids = (await findCustomersNeedingEmail(tenantId, 50)).map((c) => c.customerId);
    expect(ids).toContain(withPhone);
    expect(ids).not.toContain(noPhone); // nothing to look up by
    expect(ids).not.toContain(hasEmail);
  });

  it("lets a self_reported email overwrite an appended one (homeowner corrects)", async () => {
    const { tenantId } = await makeTenant();
    const id = await mkCustomer(tenantId, { email: "broker@x.com", emailSource: "appended" });
    expect(await setCustomerEmail(tenantId, { customerId: id, email: "home@x.com", source: "self_reported" })).toBe(true);
    expect(await read(tenantId, id)).toEqual({ email: "home@x.com", emailSource: "self_reported" });
  });
});
