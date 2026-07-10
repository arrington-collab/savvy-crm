"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addLeadSourceAction } from "@/lib/lead-source-actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Human (pickable) lead-source enum members — machine sources are never offered here. */
export const HUMAN_LEAD_SOURCES: { value: string; label: string }[] = [
  { value: "referral", label: "Referral" },
  { value: "insurance_agent", label: "Insurance agent" },
  { value: "ads", label: "Ads" },
  { value: "realtor", label: "Realtor" },
  { value: "partner", label: "Partner" },
  { value: "other", label: "Other" },
];

export function LeadSourceSelect({
  value,
  onChange,
  initialCustom,
}: {
  value: string;
  onChange: (v: string) => void;
  initialCustom: string[];
}) {
  const [custom, setCustom] = useState<string[]>(initialCustom);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();

  function add() {
    const v = draft.trim();
    if (!v) return;
    start(async () => {
      const res = await addLeadSourceAction(v);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setCustom(res.sources);
      onChange(v);
      setDraft("");
      setAdding(false);
      toast.success("Source added");
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          data-testid="lead-source"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {HUMAN_LEAD_SOURCES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {custom.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="outline"
          data-testid="lead-source-add-toggle"
          onClick={() => setAdding((a) => !a)}
        >
          + Add
        </Button>
      </div>
      {adding && (
        <div className="flex gap-2">
          <Input
            data-testid="lead-source-new"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="New source name"
          />
          <Button
            type="button"
            disabled={pending}
            data-testid="lead-source-save"
            onClick={add}
          >
            {pending ? "…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
