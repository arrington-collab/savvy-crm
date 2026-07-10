export type LeadFeedItem =
  | { kind: "comm"; id: string; at: Date; body: string; channel: string; direction: string }
  | { kind: "note"; id: string; at: Date; body: string; authorName: string | null }
  | { kind: "document"; id: string; at: Date; filename: string | null; docKind: string; mime: string | null; uploaderName: string | null };

/**
 * Merge a lead's communications, notes, and documents into one newest-first activity feed.
 * Documents are first-class timeline events (uploaded/parsed docs) so they're clickable in
 * the lead timeline, not only in the docs card. Pure so ordering/shape is unit-tested.
 */
export function buildLeadTimelineFeed(input: {
  communications: { id: string; createdAt: Date; body: string | null; channel: string; direction: string }[];
  notes: { id: string; createdAt: Date; body: string; authorName: string | null }[];
  documents: { id: string; createdAt: Date; filename: string | null; kind: string; mime: string | null; uploaderName: string | null }[];
}): LeadFeedItem[] {
  return [
    ...input.communications.map((c): LeadFeedItem => ({
      kind: "comm", id: c.id, at: c.createdAt, body: c.body ?? "", channel: c.channel, direction: c.direction,
    })),
    ...input.notes.map((n): LeadFeedItem => ({
      kind: "note", id: n.id, at: n.createdAt, body: n.body, authorName: n.authorName,
    })),
    ...input.documents.map((doc): LeadFeedItem => ({
      kind: "document", id: doc.id, at: doc.createdAt, filename: doc.filename, docKind: doc.kind, mime: doc.mime, uploaderName: doc.uploaderName,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}
