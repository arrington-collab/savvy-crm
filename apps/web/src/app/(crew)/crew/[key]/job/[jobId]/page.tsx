import { notFound } from "next/navigation";
import { getCrewSession } from "@/lib/crew-session";
import { getCrewJob } from "@/lib/crew-queries";
import { CrewJobClient } from "./CrewJobClient";

export const dynamic = "force-dynamic";

export default async function CrewJobPage({ params }: { params: Promise<{ key: string; jobId: string }> }) {
  const { jobId } = await params;
  const session = await getCrewSession();
  if (!session) notFound();
  const job = await getCrewJob(session, jobId);
  if (!job) notFound();

  return (
    <div className="space-y-4" data-testid="crew-job">
      <div>
        <h1 className="text-lg font-semibold">{job.customerName ?? "Job"}</h1>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{job.address ?? "—"} · {job.stage}</p>
      </div>
      <CrewJobClient jobId={jobId} initiallyCheckedIn={job.openCheckinAt !== null} />
    </div>
  );
}
