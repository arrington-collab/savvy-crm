"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ROOF_MATERIAL_VALUES, type RoofMaterial } from "@savvy/core";
import { resolveRoofTypeAction } from "@/lib/roof-actions";

// Human labels for the fine-grained roof materials (see @savvy/core
// ROOF_MATERIAL_VALUES). Full set so a desk confirmation is honest, not a
// coarse 3-way guess.
const MATERIAL_LABEL: Record<RoofMaterial, string> = {
  asphalt_shingle: "Asphalt shingle",
  wood_shake: "Wood shake",
  clay_tile: "Clay tile",
  concrete_tile: "Concrete tile",
  metal: "Metal",
  flat_builtup: "Flat / built-up",
  asbestos_suspect: "Asbestos-suspect",
  other: "Other",
};

/** In-place resolver for a `roof_type_needed` decision: pick the material, it
 *  writes to the property, the card drops off on the next Today render. */
export function RoofTypeActions({ propertyId }: { propertyId: string }) {
  const [pending, startTransition] = useTransition();
  const [material, setMaterial] = useState<RoofMaterial>(ROOF_MATERIAL_VALUES[0]);

  function save() {
    startTransition(async () => {
      const r = await resolveRoofTypeAction(propertyId, material);
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Roof type captured");
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select
        className="h-8 rounded-md border bg-transparent px-2 text-xs"
        value={material}
        onChange={(e) => setMaterial(e.target.value as RoofMaterial)}
        disabled={pending}
        data-testid="roof-type-material"
        aria-label="Roof material"
      >
        {ROOF_MATERIAL_VALUES.map((m) => (
          <option key={m} value={m}>{MATERIAL_LABEL[m]}</option>
        ))}
      </select>
      <Button size="sm" disabled={pending} data-testid="roof-type-resolve" onClick={save}>
        Save roof type
      </Button>
    </div>
  );
}
