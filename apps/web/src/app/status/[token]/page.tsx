import { getHomeownerStatusByToken } from "@/lib/homeowner-actions";
import { buildHomeownerJourney, homeownerStageCopy } from "@savvy/core";
import { getPhaseProgressForJob, statusGalleryForJob } from "@savvy/db";

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
  // Production Pulse: the live phase timeline (customer-visible phases only).
  const phaseProgress = res.currentStage === "production" && res.jobId
    ? await getPhaseProgressForJob({ tenantId: res.tenantId, jobId: res.jobId }).catch(() => null)
    : null;
  const gallery = res.jobId
    ? await statusGalleryForJob({ tenantId: res.tenantId, jobId: res.jobId }).catch(() => [])
    : [];
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

      {phaseProgress ? (
        <section className="mb-6" data-testid="status-phases">
          <h2 className="text-sm font-medium text-stone-500">Today on your roof</h2>
          <ol className="mt-2 space-y-1.5">
            {phaseProgress.phases.filter((p) => p.customerVisible).map((p) => (
              <li key={p.key} className="flex items-center gap-2 text-sm" data-testid={`status-phase-${p.key}`}>
                <span aria-hidden>{p.status === "done" || p.status === "verified" ? "✅" : p.status === "in_progress" ? "🔨" : "⚪"}</span>
                <span className={p.status === "in_progress" ? "font-medium" : ""}>{p.label}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {gallery.length > 0 ? (
        <section className="mb-6" data-testid="status-gallery">
          <h2 className="text-sm font-medium text-stone-500">The story so far</h2>
          {gallery.map((day) => (
            <div key={day.day} className="mt-3">
              <p className="text-xs text-stone-400">{day.day}</p>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {day.photos.map((ph) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={ph.documentId} src={`/api/status-photo/${token}/${ph.documentId}`} alt="Progress photo" loading="lazy" className="aspect-square w-full rounded-lg object-cover" data-testid={`gallery-photo-${ph.documentId}`} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}
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
