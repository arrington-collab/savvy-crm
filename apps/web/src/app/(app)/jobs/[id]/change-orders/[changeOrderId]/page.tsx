import { notFound } from "next/navigation";
import { getChangeOrder } from "@/lib/change-order-queries";
import { ChangeOrderEditor } from "./ChangeOrderEditor";
import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
import { getJobCustomerName } from "@/lib/breadcrumb-queries";

export const dynamic = "force-dynamic";

export default async function ChangeOrderPage({ params }: { params: Promise<{ id: string; changeOrderId: string }> }) {
  const { id, changeOrderId } = await params;
  const co = await getChangeOrder(changeOrderId);
  if (!co) notFound();
  const customerName = await getJobCustomerName(id);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Breadcrumb
        segments={[
          { label: "Jobs", href: "/jobs" },
          { label: customerName ?? "Job", href: `/jobs/${id}` },
          { label: "Change Order" },
        ]}
      />
      <ChangeOrderEditor changeOrder={co} jobId={id} />
    </div>
  );
}
