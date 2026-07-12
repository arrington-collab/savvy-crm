import { and, eq } from "drizzle-orm";
import type { CrewLanguage } from "@savvy/core";
import { withTenant } from "../tenant";
import { crew, crewMember, canvassRep, user } from "../schema/index";

/** A crew's current message language ('en' default). */
export async function getCrewLanguage(tenantId: string, crewId: string): Promise<CrewLanguage> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ language: crew.language }).from(crew).where(eq(crew.id, crewId));
    return (row?.language === "es" ? "es" : "en");
  });
}

/** Set a crew's message language (Team admin or the ESPAÑOL self-serve flip). */
export async function setCrewLanguage(tenantId: string, crewId: string, language: CrewLanguage): Promise<void> {
  await withTenant(tenantId, (tx) => tx.update(crew).set({ language }).where(eq(crew.id, crewId)));
}

/** Set a canvass rep's message language. */
export async function setCanvassRepLanguage(tenantId: string, repId: string, language: CrewLanguage): Promise<void> {
  await withTenant(tenantId, (tx) => tx.update(canvassRep).set({ language }).where(eq(canvassRep.id, repId)));
}

/** Resolve the crew a member belongs to from their user phone — powers the flip. */
export async function crewByMemberPhone(tenantId: string, phone: string): Promise<{ crewId: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ crewId: crewMember.crewId })
      .from(crewMember)
      .innerJoin(user, eq(user.id, crewMember.userId))
      .where(and(eq(crewMember.tenantId, tenantId), eq(user.phone, phone)))
      .limit(1);
    return rows[0] ?? null;
  });
}
