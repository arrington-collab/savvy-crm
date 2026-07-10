import { describe, it, expect } from "vitest";
import { buildLeadTimelineFeed } from "./lead-timeline";

const d = (iso: string) => new Date(iso);

describe("buildLeadTimelineFeed", () => {
  it("merges comms, notes, and documents into one feed sorted newest-first", () => {
    const feed = buildLeadTimelineFeed({
      communications: [{ id: "c1", createdAt: d("2026-07-01T10:00:00Z"), body: "call", channel: "voice", direction: "in" }],
      notes: [{ id: "n1", createdAt: d("2026-07-03T10:00:00Z"), body: "soft decking", authorName: "Bob" }],
      documents: [{ id: "doc1", createdAt: d("2026-07-02T10:00:00Z"), filename: "estimate.pdf", kind: "insurance_estimate", mime: "application/pdf", uploaderName: "Alice" }],
    });
    expect(feed.map((f) => f.id)).toEqual(["n1", "doc1", "c1"]);
    expect(feed.map((f) => f.kind)).toEqual(["note", "document", "comm"]);
  });

  it("includes a document event with everything the viewer/row needs", () => {
    const feed = buildLeadTimelineFeed({
      communications: [],
      notes: [],
      documents: [{ id: "doc1", createdAt: d("2026-07-02T10:00:00Z"), filename: "meas.pdf", kind: "measurement_report", mime: "application/pdf", uploaderName: "Alice" }],
    });
    expect(feed[0]).toEqual({
      kind: "document",
      id: "doc1",
      at: d("2026-07-02T10:00:00Z"),
      filename: "meas.pdf",
      docKind: "measurement_report",
      mime: "application/pdf",
      uploaderName: "Alice",
    });
  });

  it("is empty when there is nothing", () => {
    expect(buildLeadTimelineFeed({ communications: [], notes: [], documents: [] })).toEqual([]);
  });
});
