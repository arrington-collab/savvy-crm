import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant } from "../schema/index.js";
import {
  setOnboardingRequiredComplete,
  setOnboardingProfile,
  dismissOnboarding,
} from "./onboarding.js";

const ids: string[] = [];
async function makeTenant(settings: Record<string, unknown> = {}): Promise<string> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "T", publicKey: `ob-${crypto.randomUUID()}`, settings })
    .returning({ id: tenant.id });
  ids.push(t!.id);
  return t!.id;
}

afterAll(async () => {
  if (ids.length) await adminDb.delete(tenant).where(inArray(tenant.id, ids));
  await pool.end();
  await adminPool.end();
});

describe("onboarding write helpers", () => {
  it("setOnboardingRequiredComplete sets name + stamps requiredCompletedAt, preserves siblings", async () => {
    const id = await makeTenant({ scheduling: { hours: "9-5" } });
    await setOnboardingRequiredComplete({ tenantId: id, name: "Acme Roofing" });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    expect(t!.name).toBe("Acme Roofing");
    const s = t!.settings as Record<string, any>;
    expect(typeof s.onboarding.requiredCompletedAt).toBe("string");
    expect(s.scheduling).toEqual({ hours: "9-5" }); // sibling preserved
  });

  it("setOnboardingProfile sets revenueBand + finance.timezone, preserves onboarding key", async () => {
    const id = await makeTenant({ onboarding: { requiredCompletedAt: "x", dismissed: false } });
    await setOnboardingProfile({ tenantId: id, revenueBand: "growth", timezone: "America/New_York" });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    expect(t!.revenueBand).toBe("growth");
    const s = t!.settings as Record<string, any>;
    expect(s.finance.timezone).toBe("America/New_York");
    expect(s.onboarding.requiredCompletedAt).toBe("x"); // sibling preserved
  });

  it("dismissOnboarding sets dismissed without clearing requiredCompletedAt", async () => {
    const id = await makeTenant({ onboarding: { requiredCompletedAt: "x", dismissed: false } });
    await dismissOnboarding({ tenantId: id });
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, id));
    const s = t!.settings as Record<string, any>;
    expect(s.onboarding.dismissed).toBe(true);
    expect(s.onboarding.requiredCompletedAt).toBe("x");
  });

  it("only writes the targeted tenant — a sibling tenant is untouched", async () => {
    const a = await makeTenant({});
    const b = await makeTenant({ onboarding: { requiredCompletedAt: "keep", dismissed: false } });
    await setOnboardingProfile({ tenantId: a, revenueBand: "scale", timezone: "America/Denver" });
    const [tb] = await adminDb.select().from(tenant).where(eq(tenant.id, b));
    expect(tb!.revenueBand).toBeNull();
    const sb = tb!.settings as Record<string, any>;
    expect(sb.onboarding.requiredCompletedAt).toBe("keep");
  });
});
