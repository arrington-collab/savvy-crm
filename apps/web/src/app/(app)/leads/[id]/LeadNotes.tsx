"use client";
import { useState, useTransition } from "react";
import { addLeadNoteAction } from "@/lib/lead-actions";
import { Card } from "@/components/ui/card";

/**
 * Quick-add for append-only lead notes. No edit/delete UI by design — a note
 * is a permanent record of what was said/done. Notes render in the merged
 * notes/comms feed below (see page.tsx), not here.
 */
export function LeadNotes({ leadId }: { leadId: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function add() {
    setError(null);
    if (!value.trim()) return;
    start(async () => {
      const r = await addLeadNoteAction(leadId, value);
      if ("ok" in r) setValue("");
      else setError(r.error);
    });
  }

  return (
    <Card className="p-4 flex items-center gap-3 text-sm">
      <span style={{ color: "var(--text-faint)" }}>Add note</span>
      <input
        type="text"
        data-testid="lead-note-input"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder="e.g. south facet soft decking"
        className="flex-1 rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      />
      <button
        type="button"
        data-testid="lead-note-add"
        disabled={pending || !value.trim()}
        onClick={add}
        className="rounded-md border px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        Add
      </button>
      {error && <span style={{ color: "var(--accent-red, red)" }}>{error}</span>}
    </Card>
  );
}
