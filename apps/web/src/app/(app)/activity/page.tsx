import { Suspense } from "react";
import { parseActivityQuery } from "@savvy/core";
import { loadActivityPage } from "@/lib/command-center-queries";
import { ActivityFeed } from "@/components/activity/ActivityFeed";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const opts = parseActivityQuery((k) => sp[k]);
  const { rows } = await loadActivityPage(opts);
  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow">Telemetry</div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Everything your agents and team are doing — live.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>}>
        <ActivityFeed initial={rows} />
      </Suspense>
    </div>
  );
}
