import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, crew, crewMember, canvassRep, user } from "../src/index.js";
import { makeTenant, makeUser } from "./helpers.js";
import { getCrewLanguage, setCrewLanguage, setCanvassRepLanguage, crewByMemberPhone } from "../src/lifecycle/crew-language.js";

describe("crew language lifecycle", () => {
  it("reads the default, sets a new language, and matches a member by phone", async () => {
    const { tenantId } = await makeTenant();
    const { userId } = await makeUser(tenantId);
    const phone = `+1577${Date.now().toString().slice(-7)}`;
    await adminDb.update(user).set({ phone }).where(eq(user.id, userId));
    const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Crew A" }).returning();
    await adminDb.insert(crewMember).values({ tenantId, crewId: cr!.id, userId });

    expect(await getCrewLanguage(tenantId, cr!.id)).toBe("en");
    await setCrewLanguage(tenantId, cr!.id, "es");
    expect(await getCrewLanguage(tenantId, cr!.id)).toBe("es");

    const match = await crewByMemberPhone(tenantId, phone);
    expect(match?.crewId).toBe(cr!.id);
    expect(await crewByMemberPhone(tenantId, "+19999999999")).toBeNull();
  });

  it("sets a canvass rep's language", async () => {
    const { tenantId } = await makeTenant();
    const [rep] = await adminDb.insert(canvassRep).values({ tenantId, name: "Rep A", pinHash: "x" }).returning();
    await setCanvassRepLanguage(tenantId, rep!.id, "es");
    const [row] = await adminDb.select({ language: canvassRep.language }).from(canvassRep).where(eq(canvassRep.id, rep!.id));
    expect(row!.language).toBe("es");
  });
});
