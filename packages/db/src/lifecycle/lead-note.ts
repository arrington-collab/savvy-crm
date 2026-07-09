import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { leadNote } from "../schema/index";

/**
 * Append-only lead notes: no update/delete export exists by design — a note
 * is a permanent record of what was said/done, not an editable field.
 */
export async function addLeadNote(
  tx: Tx,
  args: { tenantId: string; leadId: string; authorUserId: string | null; body: string },
): Promise<{ id: string }> {
  const body = args.body.trim();
  if (!body) throw new Error("note body is required");
  const [row] = await tx
    .insert(leadNote)
    .values({ tenantId: args.tenantId, leadId: args.leadId, authorUserId: args.authorUserId, body })
    .returning({ id: leadNote.id });
  return row!;
}

export async function getLeadNotes(tx: Tx, args: { tenantId: string; leadId: string }) {
  return tx
    .select()
    .from(leadNote)
    .where(and(eq(leadNote.tenantId, args.tenantId), eq(leadNote.leadId, args.leadId)))
    .orderBy(desc(leadNote.createdAt));
}
