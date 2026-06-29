import { getHomeownerStatusByToken } from "@/lib/homeowner-actions";
import { buildHomeownerJourney, homeownerStageCopy } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await getHomeownerStatusByToken(token);
  if ("error" in res) {
    return (
      <main className="mx-auto max-w-md p-8 text-center" data-testid="status-invalid">
        <h1 className="text-xl font-semibold">Link unavailable</h1>
        <p className="mt-2 text-muted-foreground">This status link is invalid or expired. Please contact us.</p>
      </main>
    );
  }
  const copy = homeownerStageCopy(res.currentStage);
  const journey = buildHomeownerJourney(res.currentStage);
  return (
    <main className="mx-auto max-w-md p-6" data-testid="status-page">
      <p className="text-sm text-muted-foreground">{res.companyName}</p>
      <h1 className="text-2xl font-semibold" data-testid="status-headline">{copy.headline}</h1>
      <p className="text-muted-foreground mb-1">{copy.body}</p>
      {res.address && <p className="text-sm text-muted-foreground mb-4">{res.address}</p>}

      {res.nextAppointment && (
        <div className="rounded-md border p-3 mb-4" data-testid="status-next-appt">
          <div className="text-xs uppercase text-muted-foreground">Next appointment</div>
          <div className="font-medium">{res.nextAppointment.type} — {new Date(res.nextAppointment.startsAt).toLocaleString()}</div>
        </div>
      )}

      <ol className="space-y-2" data-testid="status-journey">
        {journey.map((m) => (
          <li key={m.key} data-testid={`milestone-${m.key}`} data-status={m.status} className="flex items-center gap-2">
            <span>{m.status === "done" ? "✓" : m.status === "current" ? "→" : "○"}</span>
            <span className={m.status === "upcoming" ? "text-muted-foreground" : "font-medium"}>{m.label}</span>
          </li>
        ))}
      </ol>
    </main>
  );
}
