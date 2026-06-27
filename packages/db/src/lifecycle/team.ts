import { withTenant } from "../tenant";
import { user } from "../schema";
import { and, inArray, isNull, asc } from "drizzle-orm";
import { SALES_ROLES } from "./assignment";

/** Active sales reps eligible for assignment/booking, id+name, alpha by name. */
export async function listAssignableReps(tenantId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name })
      .from(user)
      .where(and(inArray(user.role, [...SALES_ROLES]), isNull(user.deactivatedAt)))
      .orderBy(asc(user.name)),
  );
}
