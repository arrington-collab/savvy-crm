import { getCrewSession } from "@/lib/crew-session";
import { listCrewJobs } from "@/lib/crew-queries";
import { CrewGate } from "./CrewGate";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CrewHome({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await getCrewSession();
  if (!session) return <CrewGate workspaceKey={key} />;

  const jobs = await listCrewJobs(session);
  return (
    <div className="space-y-4" data-testid="crew-jobs">
      <h1 className="text-lg font-semibold">Your jobs today</h1>
      {jobs.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No assigned jobs.</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                href={`/crew/${key}/job/${j.id}`}
                data-testid="crew-job-row"
                data-job-id={j.id}
                className="block rounded-lg border border-white/10 p-3"
              >
                <div className="font-medium">{j.customerName ?? "Job"}</div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>{j.address ?? "—"} · {j.stage}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
