"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  orderMeasurementAction,
  generateEstimateAction,
} from "@/lib/estimate-actions";

interface MeasurementSummary {
  id: string;
  areas: Record<string, unknown>;
  pitch: string | null;
}

interface EstimateActionsProps {
  jobId: string;
  propertyId: string;
  measurement: MeasurementSummary | null;
}

/** Squares from Roofr areas object — sum of area values in sq ft, convert to roofing squares. */
function squaresFromAreas(areas: Record<string, unknown>): string {
  const total = Object.values(areas).reduce<number>((sum, v) => {
    if (typeof v === "number") return sum + v;
    if (typeof v === "object" && v !== null && "area" in v && typeof (v as { area: unknown }).area === "number") {
      return sum + (v as { area: number }).area;
    }
    return sum;
  }, 0);
  const squares = total / 100;
  return squares > 0 ? squares.toFixed(1) : "—";
}

export function EstimateActions({
  jobId,
  propertyId,
  measurement,
}: EstimateActionsProps) {
  const router = useRouter();
  const [orderPending, startOrder] = useTransition();
  const [genPending, startGen] = useTransition();

  function handleOrder() {
    startOrder(async () => {
      await orderMeasurementAction(jobId, propertyId);
    });
  }

  function handleGenerate() {
    if (!measurement) return;
    startGen(async () => {
      const result = await generateEstimateAction(jobId, measurement.id);
      if ("id" in result) {
        router.push(`/jobs/${jobId}/estimates/${result.id}`);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={orderPending}
          onClick={handleOrder}
          data-testid="order-measurement-btn"
        >
          {orderPending ? "Ordering…" : "Order measurement"}
        </Button>

        {measurement && (
          <Button
            size="sm"
            disabled={genPending}
            onClick={handleGenerate}
            data-testid="generate-estimate-btn"
          >
            {genPending ? "Generating…" : "Generate estimate"}
          </Button>
        )}
      </div>

      {measurement && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="font-medium">Measurement on file · </span>
          <span className="text-muted-foreground">
            {squaresFromAreas(measurement.areas)} sq
            {measurement.pitch ? ` · ${measurement.pitch} pitch` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
