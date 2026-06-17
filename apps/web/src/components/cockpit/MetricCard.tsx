import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

/** Cockpit KPI card: mono eyebrow label + big Geist number. */
export function MetricCard({
  label,
  value,
  danger = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <Card className="p-4">
      <div className="eyebrow">{label}</div>
      <div
        className="mt-1 text-3xl font-semibold tracking-tight"
        style={{ color: danger ? "var(--status-error)" : "var(--text-primary)" }}
        data-testid={testId}
      >
        {value}
      </div>
    </Card>
  );
}
