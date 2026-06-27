"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { AssignmentConfig } from "@savvy/core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAssignmentAction } from "@/lib/assignment-actions";

type Rep = { id: string; name: string };
const STRATEGIES = [
  { v: "off", label: "Off (assign manually)" },
  { v: "round_robin", label: "Round-robin" },
  { v: "least_loaded", label: "Least-loaded" },
  { v: "territory", label: "By territory (zip → city → state)" },
  { v: "score", label: "By lead score" },
];

export function LeadAssignmentSettings({ reps, initial }: { reps: Rep[]; initial: AssignmentConfig }) {
  const [strategy, setStrategy] = useState<AssignmentConfig["strategy"]>(initial.strategy);
  const [territory, setTerritory] = useState(initial.territoryRules ?? []);
  const [tiers, setTiers] = useState(initial.scoreTiers ?? []);
  const [pending, start] = useTransition();
  const repName = (id: string) => reps.find((r) => r.id === id)?.name ?? id;

  function save() {
    // Drop blank fields so a zip-only (or state-only) rule passes the schema's
    // "zip or state required" refine and the .min(1) checks — empty inputs must
    // not be persisted as "".
    const cleanedTerritory = territory.map((r) => ({
      userId: r.userId,
      ...(r.zip?.trim() ? { zip: r.zip.trim() } : {}),
      ...(r.state?.trim() ? { state: r.state.trim() } : {}),
      ...(r.city?.trim() ? { city: r.city.trim() } : {}),
    }));
    const config: AssignmentConfig = {
      strategy,
      ...(strategy === "territory" ? { territoryRules: cleanedTerritory } : {}),
      ...(strategy === "score" ? { scoreTiers: tiers } : {}),
    };
    start(async () => {
      const res = await saveAssignmentAction(config);
      if ("error" in res) toast.error(res.error);
      else toast.success("Saved");
    });
  }

  return (
    <Card className="max-w-2xl p-6 space-y-5" data-testid="assignment-settings">
      <div className="space-y-1.5">
        <Label htmlFor="strategy">Assignment strategy</Label>
        <select
          id="strategy"
          data-testid="assignment-strategy"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as AssignmentConfig["strategy"])}
          className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
        >
          {STRATEGIES.map((s) => (
            <option key={s.v} value={s.v}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {strategy === "territory" && (
        <div className="space-y-2" data-testid="territory-editor">
          <Label>Territory rules (zip matches first, then city, then state; ties broken by round-robin)</Label>
          {territory.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input
                placeholder="ZIP (85203)"
                data-testid={`territory-zip-${i}`}
                value={r.zip ?? ""}
                onChange={(e) =>
                  setTerritory(territory.map((x, j) => (j === i ? { ...x, zip: e.target.value } : x)))
                }
                className="w-32"
              />
              <Input
                placeholder="State (AZ)"
                data-testid={`territory-state-${i}`}
                value={r.state ?? ""}
                onChange={(e) =>
                  setTerritory(territory.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))
                }
              />
              <Input
                placeholder="City (optional)"
                value={r.city ?? ""}
                onChange={(e) =>
                  setTerritory(
                    territory.map((x, j) => (j === i ? { ...x, city: e.target.value || undefined } : x)),
                  )
                }
              />
              <select
                value={r.userId}
                data-testid={`territory-rep-${i}`}
                onChange={(e) =>
                  setTerritory(territory.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)))
                }
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="">— rep —</option>
                {reps.map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {rep.name}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTerritory(territory.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            data-testid="add-territory"
            onClick={() => setTerritory([...territory, { zip: "", state: "", userId: "" }])}
          >
            + Add rule
          </Button>
        </div>
      )}

      {strategy === "score" && (
        <div className="space-y-2" data-testid="score-editor">
          <Label>Score tiers (highest min that the lead meets wins)</Label>
          {tiers.map((t, i) => (
            <div key={i} className="flex gap-2 items-center">
              <Input
                type="number"
                placeholder="Min score"
                value={t.minScore}
                onChange={(e) =>
                  setTiers(tiers.map((x, j) => (j === i ? { ...x, minScore: Number(e.target.value) } : x)))
                }
                className="w-28"
              />
              <span className="text-sm text-muted-foreground flex-1">
                {t.userIds.length ? t.userIds.map(repName).join(", ") : "no reps"}
              </span>
              <select
                data-testid={`tier-add-rep-${i}`}
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id && !t.userIds.includes(id))
                    setTiers(tiers.map((x, j) => (j === i ? { ...x, userIds: [...x.userIds, id] } : x)));
                }}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="">+ rep</option>
                {reps.map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {rep.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="outline" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            data-testid="add-tier"
            onClick={() => setTiers([...tiers, { minScore: 0, userIds: [] }])}
          >
            + Add tier
          </Button>
        </div>
      )}

      <Button type="button" disabled={pending} data-testid="save-assignment" onClick={save}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </Card>
  );
}
