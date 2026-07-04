import Link from "next/link";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { getPipelineBoard } from "@/lib/pipeline-queries";
import { getVelocity, getRepPerformance } from "@/lib/dashboard-queries";
import { PipelineBoard } from "./PipelineBoard";
import { PipelineMetrics } from "./PipelineMetrics";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

export default async function PipelinePage() {
  const [data, velocity, repPerf] = await Promise.all([getPipelineBoard(), getVelocity(), getRepPerformance()]);
  return (
    <div className="space-y-4" data-testid="pipeline-page">
      <PageHeader
        eyebrow="Pipeline · Lead → Paid"
        title="Pipeline"
        right={
          <div className="mono flex gap-3 text-[11px]">
            <Link href="/jobs" className="hover:text-accent-gold" style={{ color: "var(--text-muted)" }}>Manage board ↗</Link>
            <Link href="/leads" className="hover:text-accent-gold" style={{ color: "var(--text-muted)" }}>Leads funnel ↗</Link>
          </div>
        }
      />
      <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
        One continuum — a lead and a job are stages of the same thing. Cards are read-mostly: agents move them,
        and each shows <b style={{ color: "var(--accent-gold)", fontWeight: 500 }}>what it&apos;s waiting on and who owes it</b>. Act on them from Today.
      </p>
      <PipelineBoard data={data} />
      <PipelineMetrics velocity={velocity} repPerf={repPerf} />
    </div>
  );
}
