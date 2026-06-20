import { notFound } from "next/navigation";
import { getEstimate } from "@/lib/estimate-queries";
import { EstimateEditor } from "./EstimateEditor";
import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
import { getJobCustomerName } from "@/lib/breadcrumb-queries";

export const dynamic = "force-dynamic";

export default async function EstimateEditorPage({
  params,
}: {
  params: Promise<{ id: string; estimateId: string }>;
}) {
  const { id: jobId, estimateId } = await params;
  const estimate = await getEstimate(estimateId);

  if (!estimate) {
    notFound();
  }

  const customerName = await getJobCustomerName(jobId);

  return (
    <div className="space-y-4">
      <Breadcrumb
        segments={[
          { label: "Jobs", href: "/jobs" },
          { label: customerName ?? "Job", href: `/jobs/${jobId}` },
          { label: "Estimate" },
        ]}
      />
      <EstimateEditor estimate={estimate} jobId={jobId} />
    </div>
  );
}
