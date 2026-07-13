import { parseActivityQuery, parseReplayDate } from "@savvy/core";
import { loadActivityPage, loadReplayDay } from "@/lib/command-center-queries";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { ReplayView } from "@/components/activity/ReplayView";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const replayDate = parseReplayDate(sp.replay); // null → live feed

  let body: React.ReactNode;
  if (replayDate) {
    const { rows, startMs, endMs } = await loadReplayDay(replayDate);
    body = <ReplayView rows={rows} date={replayDate} startMs={startMs} endMs={endMs} />;
  } else {
    const { rows } = await loadActivityPage(parseActivityQuery((k) => sp[k]));
    body = <ActivityFeed initial={rows} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow">Telemetry</div>
        <h1 className="text-2xl font-semibold tracking-tight">{replayDate ? `Replay · ${replayDate}` : "Activity"}</h1>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {replayDate ? "A read-only playback of that day's agent activity." : "Everything your agents and team are doing — live."}
        </p>
      </div>
      {body}
    </div>
  );
}
