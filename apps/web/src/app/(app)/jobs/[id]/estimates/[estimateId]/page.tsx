import { notFound } from "next/navigation";
import { getEstimate } from "@/lib/estimate-queries";
import { EstimateEditor } from "./EstimateEditor";

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

  return <EstimateEditor estimate={estimate} jobId={jobId} />;
}
