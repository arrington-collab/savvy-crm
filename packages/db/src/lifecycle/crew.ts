import { and, eq, asc, isNull } from "drizzle-orm";
import { crew, crewMember, user } from "../schema/index";
import { withTenant } from "../tenant";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

export type CrewRow = typeof crew.$inferSelect;

export async function createCrew(input: { tenantId: string; name: string }): Promise<CrewRow> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.insert(crew).values({ tenantId: input.tenantId, name: input.name }).returning();
    return row!;
  });
}

export async function listCrews(
  tenantId: string,
): Promise<{ id: string; name: string; active: boolean; language: string; baseLat: number | null; baseLng: number | null; hasPin: boolean; members: { userId: string; name: string }[] }[]> {
  return withTenant(tenantId, async (tx) => {
    const crews = await tx
      .select()
      .from(crew)
      .where(eq(crew.tenantId, tenantId))
      .orderBy(asc(crew.name));

    const members = await tx
      .select({ crewId: crewMember.crewId, userId: crewMember.userId, name: user.name })
      .from(crewMember)
      .innerJoin(user, eq(crewMember.userId, user.id))
      .where(eq(crewMember.tenantId, tenantId));

    return crews.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.active,
      language: c.language,
      baseLat: c.baseLat ?? null,
      baseLng: c.baseLng ?? null,
      // Expose only whether a shared PIN is set — never the hash itself.
      hasPin: c.pinHash != null,
      members: members
        .filter((m) => m.crewId === c.id)
        .map((m) => ({ userId: m.userId, name: m.name })),
    }));
  });
}

/** Set (or clear, with nulls) a crew's home-base location for drive-time routing. */
export async function setCrewLocation(input: {
  tenantId: string; crewId: string; baseLat: number | null; baseLng: number | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(crew)
      .set({ baseLat: input.baseLat, baseLng: input.baseLng })
      .where(and(eq(crew.id, input.crewId), eq(crew.tenantId, input.tenantId))),
  );
}

/** Set (or clear, with null) a crew's shared login PIN hash. Hashing is done by the caller. */
export async function setCrewPinHash(input: {
  tenantId: string; crewId: string; pinHash: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(crew)
      .set({ pinHash: input.pinHash })
      .where(and(eq(crew.id, input.crewId), eq(crew.tenantId, input.tenantId))),
  );
}

/**
 * Active crews (with their active crew-role members) for the shared-PIN login flow.
 * Returns the pinHash so the caller can verifyPin — server-only; never expose to a client.
 */
export async function getCrewLoginCandidates(
  tenantId: string,
): Promise<{ id: string; pinHash: string | null; members: { id: string; name: string }[] }[]> {
  return withTenant(tenantId, async (tx) => {
    const crews = await tx
      .select({ id: crew.id, pinHash: crew.pinHash })
      .from(crew)
      .where(and(eq(crew.tenantId, tenantId), eq(crew.active, true)));

    const members = await tx
      .select({ crewId: crewMember.crewId, userId: crewMember.userId, name: user.name })
      .from(crewMember)
      .innerJoin(user, eq(crewMember.userId, user.id))
      .where(and(eq(crewMember.tenantId, tenantId), eq(user.role, "crew"), isNull(user.deactivatedAt)));

    return crews.map((c) => ({
      id: c.id,
      pinHash: c.pinHash ?? null,
      members: members
        .filter((m) => m.crewId === c.id)
        .map((m) => ({ id: m.userId, name: m.name })),
    }));
  });
}

export async function renameCrew(input: { tenantId: string; crewId: string; name: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(crew)
      .set({ name: input.name })
      .where(and(eq(crew.id, input.crewId), eq(crew.tenantId, input.tenantId))),
  );
}

export async function setCrewActive(input: { tenantId: string; crewId: string; active: boolean }): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(crew)
      .set({ active: input.active })
      .where(and(eq(crew.id, input.crewId), eq(crew.tenantId, input.tenantId))),
  );
}

export async function addCrewMember(input: { tenantId: string; crewId: string; userId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.insert(crewMember)
      .values({ tenantId: input.tenantId, crewId: input.crewId, userId: input.userId })
      .onConflictDoNothing(),
  );
}

export async function removeCrewMember(input: { tenantId: string; crewId: string; userId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.delete(crewMember)
      .where(
        and(
          eq(crewMember.tenantId, input.tenantId),
          eq(crewMember.crewId, input.crewId),
          eq(crewMember.userId, input.userId),
        ),
      ),
  );
}

/** Takes a tx as first arg (like other tx-taking fns). Returns the crew ids the user belongs to. */
export async function listCrewIdsForUser(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ crewId: crewMember.crewId })
    .from(crewMember)
    .where(and(eq(crewMember.tenantId, tenantId), eq(crewMember.userId, userId)));
  return rows.map((r) => r.crewId);
}

/** Phone/email of every member user of a crew (for crew notifications). */
export async function getCrewContacts(input: { tenantId: string; crewId: string }): Promise<{ phone: string | null; email: string }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ phone: user.phone, email: user.email })
      .from(crewMember)
      .innerJoin(user, eq(user.id, crewMember.userId))
      .where(and(eq(crewMember.tenantId, input.tenantId), eq(crewMember.crewId, input.crewId)));
    return rows.map((r) => ({ phone: r.phone, email: r.email }));
  });
}
