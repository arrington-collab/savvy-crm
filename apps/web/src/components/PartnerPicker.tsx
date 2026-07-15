"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { searchPartnersAction } from "@/lib/partner-actions";

// Partner Ledger attribution hygiene: partners are PICKED (typeahead) or
// created once inline — the form never submits a bare free-text name.
export type PartnerSelection =
  | { kind: "existing"; id: string; label: string }
  | { kind: "new"; name: string; org?: string };

type Match = { id: string; name: string; org: string | null; class: string };

export function PartnerPicker({
  value,
  onChange,
  orgLabel = "Company (optional)",
}: {
  value: PartnerSelection | null;
  onChange: (v: PartnerSelection | null) => void;
  orgLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!query.trim() || value) {
        setMatches([]);
        setOpen(false);
        return;
      }
      const found = await searchPartnersAction(query);
      setMatches(found);
      setOpen(true);
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, value]);

  function pick(m: Match) {
    onChange({ kind: "existing", id: m.id, label: m.org ? `${m.name} — ${m.org}` : m.name });
    setOpen(false);
    setQuery("");
  }

  function startAdd() {
    setAdding(true);
    setOpen(false);
    setNewName(query.trim());
    setNewOrg("");
  }

  function confirmAdd() {
    if (!newName.trim()) return;
    onChange({ kind: "new", name: newName.trim(), org: newOrg.trim() || undefined });
    setAdding(false);
  }

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border p-2 text-sm" data-testid="partner-selected">
        <span>
          {value.kind === "existing" ? value.label : `${value.name}${value.org ? ` — ${value.org}` : ""} (new)`}
        </span>
        <Button type="button" variant="ghost" size="sm" data-testid="partner-clear" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  if (adding) {
    return (
      <div className="space-y-3 rounded-md border p-3" data-testid="partner-add-form">
        <div className="space-y-1.5">
          <Label htmlFor="partner-new-name">Partner name</Label>
          <Input id="partner-new-name" data-testid="partner-new-name" value={newName}
                 onChange={(e) => setNewName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="partner-new-org">{orgLabel}</Label>
          <Input id="partner-new-org" data-testid="partner-new-org" value={newOrg}
                 onChange={(e) => setNewOrg(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" data-testid="partner-add-confirm" onClick={confirmAdd} disabled={!newName.trim()}>
            Add partner
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        data-testid="partner-search"
        value={query}
        placeholder="Search partners…"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query.trim() && setOpen(true)}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md" data-testid="partner-matches">
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => pick(m)}
            >
              {m.name}
              {m.org ? <span className="text-muted-foreground"> — {m.org}</span> : null}
            </button>
          ))}
          <button
            type="button"
            className="block w-full border-t px-3 py-2 text-left text-sm text-primary hover:bg-accent"
            data-testid="partner-add-new"
            onClick={startAdd}
          >
            + Add {query.trim() ? `“${query.trim()}”` : "new partner"}
          </button>
        </div>
      )}
    </div>
  );
}
