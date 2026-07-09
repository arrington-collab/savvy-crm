import { describe, it, expect } from "vitest";
import { withTenant, addLeadNote, getLeadNotes } from "../src/index.js";
import { makeTenant, makeUser, makeLeadWithProperty } from "./helpers.js";

describe("lead notes — append-only", () => {
  it("adds notes and reads them newest-first", async () => {
    const { tenantId } = await makeTenant();
    const { userId: authorUserId } = await makeUser(tenantId);
    const { leadId } = await makeLeadWithProperty(tenantId);

    await withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "first" }));
    await withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "second" }));

    const notes = await withTenant(tenantId, (tx) => getLeadNotes(tx, { tenantId, leadId }));
    expect(notes.map((n) => n.body)).toEqual(["second", "first"]);
  });

  it("rejects an empty body", async () => {
    const { tenantId } = await makeTenant();
    const { userId: authorUserId } = await makeUser(tenantId);
    const { leadId } = await makeLeadWithProperty(tenantId);

    await expect(
      withTenant(tenantId, (tx) => addLeadNote(tx, { tenantId, leadId, authorUserId, body: "   " })),
    ).rejects.toThrow();
  });
});
